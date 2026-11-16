// The coordinator's run (U3, minimal): discover the project's files, order them, push them
// through the pool, and report to the bus. The CLI, `run()` and config loading are `provino`'s.
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { pruneTransformCache, type ResolvedProject, withTransformCache } from '@provino/config'
import { readIsolatePragma, tierFor } from '@provino/loader'
import { serializeError } from '@provino/rpc'
import { resolveUpdateMode } from '@provino/snapshot/node'
import type {
  AffectedSelection,
  CoverageSummary,
  FileFilter,
  FileInfo,
  FileJob,
  FileResult,
  IsolationTier,
  OpenHandle,
  OrchestratorPolicy,
  PoolKind,
  PoolOptions,
  RecyclePolicy,
  ReporterBus,
  RunEndReason,
  RunInfo,
  RunSummary,
  ScheduleInput,
  SerializedError,
  SerializedProjectConfig,
  TaskResult,
  TaskState,
  TimingsFile,
  TransportFactory,
  WorkerEvent,
  WorkerExit,
  WorkerKey,
} from '@provino/types'
import { affectedCachePaths } from './affected/index.ts'
import { openRecordedGraph, type RecordedGraph } from './affected/recorded.ts'
import { keepFailed, selectAffected } from './affected/select.ts'
import { cacheDirectories, createResultsCache, type ResultsCache } from './cache.ts'
import type { RunCoverageHooks } from './coverage.ts'
import { createDepsTable, type DepsTable } from './deps-table.ts'
import { type DiscoveredFile, discoverFiles } from './discover.ts'
import { discoverByRules } from './discover-rules.ts'
import { createFileDispatch, createIdleDispatch } from './dispatch.ts'
import { OrchestratorError } from './errors.ts'
import { isRunSignal, RUN_SIGNALS } from './exit-code.ts'
import { fileIdOf, relativePosix } from './file-id.ts'
import { type GlobalSetupRun, type RunGlobalHooks, runGlobalSetup } from './global-setup.ts'
import { shouldRunInBand } from './in-band.ts'
import { createInlineSnapshotWrites, withInlineSnapshots } from './inline-snapshots.ts'
import { configHash, hashOf, type WorkerKeyInput, workerKeyOf } from './key.ts'
import { learnExternals, readLearnedExternals } from './learned-externals.ts'
import { prepareObsoleteSnapshotCleanup } from './obsolete-snapshots.ts'
import { collectOpenHandles, type OpenHandleTracker } from './open-handles.ts'
import {
  createPool,
  defaultMaxWorkers,
  type Pool,
  type PoolDeps,
  type PoolOutcome,
} from './pool.ts'
import { selectFiles } from './select.ts'
import { createHistorySequencer } from './sequencer.ts'
import { checkShard, type ShardSpec, shardFiles } from './shard.ts'
import {
  mergedSnapshots,
  type SnapshotMember,
  snapshotMember,
  snapshotsFailRun,
} from './snapshot-members.ts'
import { mergeTimings, readTimings, TIMINGS_FILE_NAME, writeTimings } from './timings.ts'
import { transportFor } from './transport/for-kind.ts'
import { describeExit } from './transport/shared.ts'
import { BATCH, mapInBatches, messageOf } from './util.ts'

/** `orchestrator.inBand` that never puts a run in band by itself. */
const NO_AUTOMATIC_IN_BAND = { single: false, fastFileCount: 0, slowMs: 0 } as const

/** Track 9: how long a worker may take to say `ready`, and to stop before it is killed. */
const START_TIMEOUT_MS = 30_000
const TEARDOWN_TIMEOUT_MS = 10_000

/**
 * The pool's settings a run can override; the rest come from the project's policy.
 * @public
 */
export interface RunPoolOptions {
  /**
   * Default `policy.orchestrator.pool.default`. Naming a kind also turns off the policy's automatic
   * choice to run in band (`orchestrator.inBand`): the caller has chosen, unless
   * `automaticInBand` says otherwise. `runInBand` and `detectOpenHandles` still run in band.
   */
  readonly kind?: PoolKind
  /**
   * Whether the policy's `orchestrator.inBand` may still put the run in band. Default: only when
   * no `kind` is named. `true` makes `kind` the pool to use when the run is not in band (Jest's
   * `--workerThreads`, which `shouldRunInBand` never reads); `false` turns the choice off even
   * without a `kind`.
   */
  readonly automaticInBand?: boolean
  /**
   * Default `defaultMaxWorkers()`. The transport can cap it: an `inline` pool ignores it and runs
   * exactly one worker (`--runInBand`; see `TransportFactory.maxWorkers`).
   */
  readonly maxWorkers?: number
  /**
   * When a worker is replaced (`RecyclePolicy`). The memory limit defaults to
   * `defaultWorkerMemoryLimit` (`max(512 MiB, 25% of the machine's, or the container's, memory
   * / maxWorkers)`); `Number.POSITIVE_INFINITY` turns the check off.
   */
  readonly recycle?: RecyclePolicy
  readonly startTimeoutMs?: number
  readonly teardownTimeoutMs?: number
  /** Node flags for the workers (forks and threads). Default: this process's, for the pool key. */
  readonly execArgv?: readonly string[]
  /**
   * Variables Node reads when a forked worker starts, that no test may see (`NODE_COMPILE_CACHE`,
   * for the bin's compile cache; Jest sets none): in the fork's spawn environment, removed from its
   * own `process.env` before any file loads. Forks only. See `ForksTransportOptions.startupEnv`.
   */
  readonly startupEnv?: Readonly<Record<string, string>>
  /**
   * The most one test file may run, in ms. A worker still on a file after it is killed and the
   * file fails with the worker's exit `{ type: 'timeout', phase: 'file' }`. Default: none (Jest
   * has none either: a synchronous loop in a test hangs it too). An inline worker shares this
   * process, so a synchronous hang can't be stopped, and an asynchronous one only loses its link.
   */
  readonly fileTimeoutMs?: number
  /**
   * The old-generation heap limit of each worker, in MB: a fork gets `--max-old-space-size`, a
   * thread `resourceLimits`. A worker that goes over it fails its file with `{ type: 'oom' }`.
   * Default: V8's.
   */
  readonly heapLimitMb?: number
}

/**
 * The memory a worker may hold before it is replaced, by default: `max(512 MiB, 25% of the
 * memory available to the process / maxWorkers)`, the memory being the container's cap
 * (`process.constrainedMemory()`) or else the machine's (Track 9 §Pool 3). A cap is never more
 * than the machine has: a cgroup with no limit reports about 2^64 bytes.
 * @public
 */
export function defaultWorkerMemoryLimit(maxWorkers: number): number {
  const machine = totalmem()
  const constrained: unknown = process.constrainedMemory()
  const available =
    typeof constrained === 'number' && constrained > 0 ? Math.min(constrained, machine) : machine
  return Math.max(512 * 1024 * 1024, Math.floor((0.25 * available) / Math.max(1, maxWorkers)))
}

/**
 * Options for `runProject`.
 * @public
 */
export interface RunProjectOptions {
  /** Every event of the run goes through it. */
  readonly bus: ReporterBus
  readonly pool?: RunPoolOptions
  /**
   * The results cache that orders the run and records it. Omitted: the one in
   * `<rootDir>/node_modules/.cache/provino`. `false`: none, so the run neither reads nor writes
   * history. A run prunes the project's history of files it did not discover (see `prune`).
   */
  readonly cache?: ResultsCache | false
  /** Run only tests whose full name matches (`-t`). Validated once, here, before anything starts. */
  readonly testNamePattern?: string
  /** Rewrite the snapshots that differ (`-u`). Default `false`: new ones are written, unless this is a CI run. */
  readonly update?: boolean
  /**
   * `--passWithNoTests`; absent: each project's `orchestrator.passWithNoTests`. A run that finds no
   * file passes (`exitCodeFor` reads it too) and, under `noTestsFile:
   * 'fail-unless-pass-with-no-tests'`, so does a file that declares no test.
   */
  readonly passWithNoTests?: boolean
  /** Where the policy's snapshot update variable is read (Vitest's `UPDATE_SNAPSHOT`). Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Run only the files these filters keep (`selectFiles`). A filtered run still discovers every
   * file, so the results cache is pruned against the whole set and keeps the history of the
   * files it did not run.
   */
  readonly fileFilters?: readonly FileFilter[]
  /**
   * A project's own say over which of its files run, after `fileFilters` and before the shard
   * (Jest's `--filter`): it gets the project (the object the caller passed, so it can key what it
   * remembers by it) and the files the filters kept, with their absolute paths, and returns the
   * ones that run. It is called once per project. It decides nothing about the history, which is
   * still pruned against the whole discovered set. A rejection ends the run before anything starts.
   */
  readonly fileFilter?: (
    project: ResolvedProject,
    files: readonly DiscoveredFile[],
  ) => Promise<readonly DiscoveredFile[]> | readonly DiscoveredFile[]
  /**
   * Run in band: the files run one at a time in this process (the `inline` pool), and a test's
   * `console` still reaches the reporters as events (Jest's `-i`, `--runInBand`). The policy's
   * `orchestrator.inBand` can also put a small run in band by itself, and `detectOpenHandles`
   * always does.
   */
  readonly runInBand?: boolean
  /**
   * Run only the tests this selection reaches (`--findRelatedTests`, `-o`), per project after
   * discovery. When set, `fileFilters` are not applied: Jest ignores path patterns in related
   * mode. A project's own affected index decides (`@provino/orchestrator`'s `createAffectedIndex`).
   */
  readonly selection?: AffectedSelection
  /**
   * Keep only the files that failed (`--onlyFailures`), after the sort: `'history'` takes them
   * from the results cache (`FileHistory.failed`; a run with no cache is `ORCH_BAD_OPTION`), or a set
   * of absolute paths names them. It is applied after the shard, and the results cache is still
   * pruned against every discovered file, so the history of the files left out stays.
   */
  readonly onlyFailures?: 'history' | ReadonlySet<string>
  /** Where an exact-path filter that is relative starts. Default: this process's directory. */
  readonly cwd?: string
  /**
   * Where the workers' own stdout goes (a fork's or thread's direct write to fd 1; not the
   * tests' `console`, which is an event). Default: this process's. A caller that prints
   * machine-readable output on its own stdout passes its stderr here. An inline worker shares
   * this process, so its direct writes reach the process's stdout whatever this says.
   */
  readonly stdout?: NodeJS.WritableStream
  /** Where the workers' own stderr goes (a crash's last words). Default: this process's. */
  readonly stderr?: NodeJS.WritableStream
  /** The worker entry, a `file:` URL or an absolute path. Default: `@provino/orchestrator/worker/main`. */
  readonly entry?: string | URL
  /**
   * Aborting stops the run: no file starts, and the workers running files are killed. A file that
   * had started ends as a failure (`file:end`, one error naming the interruption, in the summary);
   * a file that had not is not reported (no `file:start` or `file:end`, not in the summary). The
   * run ends with `reason: 'interrupted'`, `'terminated'` when the signal was aborted with the
   * reason `'SIGTERM'` (`controller.abort('SIGTERM')`) and `'hangup'` for `'SIGHUP'`: the bin's exit
   * codes 130, 143 and 129 (`RUN_SIGNALS`).
   */
  readonly signal?: AbortSignal
  /**
   * Aborting it kills every worker at once, the ones still stopping gracefully included, so the
   * run ends without waiting for a slow teardown: the second Ctrl+C. It also aborts the run, as
   * `signal` does.
   */
  readonly forceSignal?: AbortSignal
  /**
   * End the run once this many tests have failed (`--bail`). When it is checked is the policy's
   * `orchestrator.bail.checkAfter` (the first project's): after each file (Jest: the files that
   * have ended are all reported, the others are never started, the files still running are killed
   * and, as in Jest, not reported, and the run ends `failed`), or after each test (Vitest: no
   * file starts, and the files running go on to their end, since a running file can't be
   * cancelled before T5.12).
   */
  readonly bail?: { readonly count: number }
  /**
   * Report what is still open after the last file, and where it was made (`--detectOpenHandles`).
   * It needs the files to run in this process, so the pool is `inline` whatever `pool.kind` says.
   * The handles are `RunSummary.openHandles`.
   */
  readonly detectOpenHandles?: boolean
  /** `RunInfo.root` of a run over several projects (Jest's config `rootDir`). Default: the first project's root. */
  readonly root?: string
  /**
   * Run only shard `index` of `count` of the files (`--shard=index/count`, 1-based): after the file
   * filters, across every project, as Jest shards one list. With any time in the timings file, the
   * shard is a contiguous run of the path-sorted files cut by predicted time; with none, the first
   * project's `orchestrator.shard.fallback` splits them (Jest's sha1 split under the Jest dialect).
   * The results cache is untouched by what the shard leaves out.
   */
  readonly shard?: ShardSpec
  /**
   * The committed timings file (`provino.timings.json`, T9.6): what `shard` cuts by, and what
   * `update` writes. Read only when the run shards or updates.
   */
  readonly timings?: {
    /** Where it is. Default: `provino.timings.json` in the run's root. */
    readonly file?: string
    /**
     * Write each file this run ran, with its time, into the file after the run (`--update-timings`),
     * keeping every other entry, and dropping the entries of files that no longer exist when the run
     * saw every file (no file filter). A run that is cut short writes the files that ended. A file
     * that already is there but isn't a timings file is replaced. A run with a `testNamePattern`
     * writes nothing (it times some of each file's tests, not the files) and says so on stderr. It
     * can't be combined with `shard` (`ORCH_BAD_OPTION`): shards that run one after another in one
     * checkout would each read the timings the last one wrote, and cut the files differently.
     */
    readonly update?: boolean
  }
  /**
   * Hooks of the run itself, beside the projects': Jest's root `globalSetup` and
   * `globalTeardown`, which a config with `projects` keeps in its global config (T9.15). Each runs
   * after the projects' own, once per path no project names, with the config of the first project
   * in the sequenced order. They run only when some project has a file to run.
   */
  readonly globalSetup?: RunGlobalHooks
  /**
   * What the run tells its caller about its coverage (B23b). Coverage itself is on when a project's
   * worker config has a `coverage` block: the workers' `coverage` events are kept as they arrive
   * (Istanbul's per file, V8's once per worker), the files no test loaded are added, and the merged
   * map, moved back to the sources, is `RunSummary.coverage` before `run:end`.
   */
  readonly coverage?: RunCoverageHooks
  /**
   * Collect each file and report what its tests would do, running none (Jest's `--collectTests`):
   * no global setup or teardown runs, no hook or test body runs, no snapshot is written, and the
   * results cache and the timings file are left as they were.
   */
  readonly collectOnly?: boolean
  /**
   * Which projects check, after each of their files, that its environment can be collected (Jest's
   * `detectLeaks`, a project key): a file that holds it fails whole (`FileResult.leaks`, its
   * tests discarded). A project it names with isolation `none`, whose files share one registry
   * for the worker's life, is refused (`ORCH_BAD_OPTION`); the others are not asked.
   */
  readonly detectLeaks?: (project: ResolvedProject) => boolean
  /** Report each file's heap after it ran (Jest's `--logHeapUsage`): `FileResult.heapUsedBytes`. */
  readonly logHeapUsage?: boolean
}

/**
 * What the results cache keys a project's history by: its name and a short hash of what makes
 * the config different (root, include, exclude, and a dialect reader's discovery rules), so two
 * configs without a name in one root don't prune each other's history.
 * @public
 */
export function projectCacheKey(project: ResolvedProject): string {
  const identity = hashOf([
    project.rootDir,
    [...project.include].sort(),
    [...project.exclude].sort(),
    // A dialect reader's rules (roots, patterns) find other files than the globs do.
    project.discovery === null
      ? null
      : [
          project.discovery.roots,
          project.discovery.extensions,
          project.discovery.includePatterns.kind,
          project.discovery.includePatterns.patterns,
          project.discovery.excludePatterns,
          project.discovery.crawlIgnorePatterns,
        ],
  ])
  return `${project.name}#${identity.slice(0, 8)}`
}

/**
 * Gives each file that more than one project of the run runs (two projects sharing a root and
 * matching the same file) a `runPath` that names its project, so a reporter keyed by path (the
 * normalized-json ids) keeps one entry per run of it.
 */
function qualifyDuplicatePaths(queue: readonly QueuedFile[]): QueuedFile[] {
  const counts = new Map<string, number>()
  for (const { info } of queue) {
    const key = info.runPath ?? info.path
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return queue.map((entry) => {
    const key = entry.info.runPath ?? entry.info.path
    if ((counts.get(key) ?? 0) < 2) return entry
    return { ...entry, info: { ...entry.info, runPath: `${key}#${entry.member.identity}` } }
  })
}

/**
 * Every test file the project has: by the dialect reader's rules when it gave some, else by the
 * config's `include` and `exclude` globs.
 * @public
 */
export function discoverProject(project: ResolvedProject): Promise<readonly DiscoveredFile[]> {
  const { discovery } = project
  return discovery === null
    ? discoverFiles({
        rootDir: project.rootDir,
        include: project.include,
        exclude: project.exclude,
      })
    : discoverByRules({
        rootDir: project.rootDir,
        discovery,
        globMatchesOn: project.policy.orchestrator.globMatchesOn,
      })
}

/** `new RegExp` with the policy's flags, once; the workers get the string. */
function checkPattern(pattern: string | undefined, flags: string): void {
  if (pattern === undefined) return
  try {
    new RegExp(pattern, flags)
  } catch (error) {
    throw new OrchestratorError(
      'ORCH_BAD_PATTERN',
      `The test name pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${messageOf(error)}`,
      { cause: error },
    )
  }
}

/** A discovered file with the identity the bus knows it by. */
interface QueuedFile {
  readonly member: Member
  readonly info: FileInfo
  readonly file: DiscoveredFile
  /** The worker key this file's worker has: its project's, at the file's isolation tier. */
  readonly key: WorkerKey
  /** The path `provino.timings.json` knows the file by: relative to the run's root. */
  readonly timingsPath: string
}

/**
 * What the policy decides about a file once it has ended, with what the file's events showed: how
 * many tests ended `todo` (`todoOnlyFile`, DV50) and how many it collected (`noTestsFile`).
 */
interface FileRules {
  readonly ended: number
  readonly collected: number
  /** The worker's runner failed the file after it ran (`FileDispatch.runnerFailed`). */
  readonly runnerFailed: boolean
  readonly todoOnlyFile: 'pass' | 'skip'
  /** Whether a file that declares no test fails: `noTestsFile` with `passWithNoTests` applied. */
  readonly failsWithNoTests: boolean
}

/**
 * A file's state for reporters, decided here once (the reporters, the results cache and
 * `normalized-json` all read it): `todo` and `queued` ran nothing (`skip`), `running` never
 * finished (`fail`), and a `skip` file with a test that ended `todo` is the policy's
 * `todoOnlyFile` (Jest passes it, DV50).
 */
function stateOf(state: TaskState, rules: FileRules): FileResult['state'] {
  switch (state) {
    case 'pass':
    case 'fail':
      return state
    case 'skip':
    case 'todo':
    case 'queued':
      return rules.ended > 0 ? rules.todoOnlyFile : 'skip'
    case 'running':
      return 'fail'
    default:
      return state satisfies never
  }
}

/**
 * Whether a file that declares no test fails (`noTestsFile`): always under `fail`, and under
 * `fail-unless-pass-with-no-tests` unless the run passes with no tests, the option first and the
 * project's `passWithNoTests` otherwise (as `exitCodeFor` reads it).
 */
function failsWithNoTests(
  orchestrator: Pick<OrchestratorPolicy, 'noTestsFile' | 'passWithNoTests'>,
  passWithNoTests: boolean | undefined,
): boolean {
  switch (orchestrator.noTestsFile) {
    case 'fail':
      return true
    case 'fail-unless-pass-with-no-tests':
      return !(passWithNoTests ?? orchestrator.passWithNoTests)
    case 'pass':
      return false
    default:
      return orchestrator.noTestsFile satisfies never
  }
}

/**
 * The error of a file that declares no test and fails for it: Provino's own text. A dialect with a
 * wording of its own replaces it (the Jest dialect's result builder does, for any file that loaded
 * and has no test result).
 */
const NO_TESTS_ERROR: SerializedError = {
  name: 'Error',
  message: 'The file declares no tests',
  code: 'ORCH_NO_TESTS',
}

function crashError(file: FileInfo, exit: WorkerExit): SerializedError {
  return {
    name: 'WorkerCrash',
    message: `The worker running ${file.path} exited: ${describeExit(exit)}`,
    code: 'ORCH_WORKER_EXITED',
  }
}

/** A project with the run's seed in its worker config. */
type SeededProject = Omit<ResolvedProject, 'config'> & { readonly config: SerializedProjectConfig }

/**
 * The project's loader config with the node_modules files its workers learned to evaluate per
 * file in earlier runs (D127), from its history in `cache` under `cacheProject` (the key the run
 * also writes them under), as absolute paths. Unchanged when the policy doesn't ask for it or
 * nothing was learned.
 */
function withLearnedExternals(
  project: ResolvedProject,
  cache: ResultsCache | undefined,
  cacheProject: string,
  versions: Map<string, string>,
): SerializedProjectConfig['loader'] {
  const loader = project.config.loader
  if (cache === undefined || !project.policy.module.reevaluateHookingExternals) return loader
  const learned = readLearnedExternals(cache, cacheProject, project.rootDir, versions)
  if (learned.length === 0) return loader
  return { ...loader, reevaluate: learned }
}

/** One project of a run, with what the run decided for it once. */
interface Member {
  readonly project: SeededProject
  /** The results cache's key for the project's history. */
  readonly cacheProject: string
  /**
   * What names the project inside this run (the worker key, the file ids): its `name`, or
   * `name#hash` of its finished config when another project has the same name, and `@index` after
   * that when another one's config is byte-identical.
   */
  readonly identity: string
  /** The project's place in the run's `projects` (0-based): what a reporter keys its config by. */
  readonly projectIndex: number
  /** The project asks for the leak check after each of its files (`RunProjectOptions.detectLeaks`). */
  readonly detectLeaks: boolean
  /** What the project's files reported, its update mode and its policy. */
  readonly snapshots: SnapshotMember
  readonly cache: ResultsCache | undefined
  /** What the project's workers are keyed by, before the isolation tier of a file is added. */
  keyInput: Omit<WorkerKeyInput, 'isolation'>
  /** The worker key of each tier a file of this project runs at. */
  readonly keys: Map<IsolationTier, WorkerKey>
}

/**
 * What a watch session lends each of its runs (B23c, T9.11): its pool, which outlives the run, and
 * what must stay the same from one run to the next for a warm worker to serve it.
 * @internal
 */
export interface RunHost {
  /**
   * The session's pool, bound to this run's callbacks until the run ends. What the run does with
   * it: `drain` does nothing (the workers stay for the next run), `cancelQueued` and `close` give up
   * what this run asked for and kill its running files (`Pool.interrupt`), and the run's `signal`
   * does the same.
   */
  readonly attach: (deps: RunPoolDeps) => Pool
  /** The pool kind of every run of the session, decided once: a watch run is never put in band by itself. */
  readonly kind: PoolKind
  /** The session's pool is `inline` because the caller asked to run in band: its console is captured. */
  readonly inBand: boolean
  /** The seed a project with none gets, the same for every run: a warm worker keeps the one it booted with. */
  readonly seed: number
  /** The results caches by directory, made once for the session. */
  readonly caches: Map<string, ResultsCache>
  /** Each lockfile's hash by path, read once for the session. */
  readonly lockfileHashes: Map<string, string>
  /**
   * Each worker's table of the module paths its `deps` events named: a worker names a path once in
   * its life, so a warm worker's table must outlive the run. The session drops a table when its
   * worker exits.
   */
  readonly depsTables: Map<number, DepsTable>
  /** The files `selection` reaches in a project, from the session's own affected index. */
  readonly selectAffected: (
    project: { readonly projectIndex: number; readonly cacheProject: string },
    everything: readonly DiscoveredFile[],
    selection: AffectedSelection,
    recorded: RecordedGraph | undefined,
  ) => Promise<readonly DiscoveredFile[]>
  /** The recorded graph at `path`, opened once for the session, so its affected index reads the one each run writes. */
  readonly openRecordedGraph: (path: string) => Promise<RecordedGraph>
  /** The changed paths a worker has not been told about, which go with its next file. */
  readonly staleModules: (workerId: number) => readonly string[]
  /**
   * What this run's global setup provided (`{}` with none), before any file is asked for: a warm
   * worker booted with an earlier run's values, so the session replaces the workers when they differ.
   */
  readonly onProvided: (provided: Readonly<Record<string, unknown>>) => void
}

/**
 * What a run gives the pool it runs on: `PoolDeps` without the transport, which a session's pool
 * already has.
 * @internal
 */
export type RunPoolDeps = Omit<PoolDeps, 'transport'>

/**
 * The transport factory and the pool's options a run's settings ask for, for `kind`: what
 * `runProjects` makes its pool from, and a watch session its one pool.
 * @internal
 */
export function poolSettings(
  options: Pick<RunProjectOptions, 'pool' | 'entry' | 'stdout' | 'stderr'>,
  kind: PoolKind,
): { readonly factory: TransportFactory; readonly poolOptions: PoolOptions } {
  const startTimeoutMs = options.pool?.startTimeoutMs ?? START_TIMEOUT_MS
  const teardownTimeoutMs = options.pool?.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS
  const execArgv = options.pool?.execArgv
  const factory = transportFor(kind, {
    entry: options.entry ?? import.meta.resolve('@provino/orchestrator/worker/main'),
    startTimeoutMs,
    teardownTimeoutMs,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    ...(execArgv === undefined ? {} : { execArgv }),
    ...(options.pool?.startupEnv === undefined ? {} : { startupEnv: options.pool.startupEnv }),
    ...(options.pool?.heapLimitMb === undefined ? {} : { memoryLimitMb: options.pool.heapLimitMb }),
  })
  // The transport can cap the workers, whatever is asked for: an inline pool runs one.
  const maxWorkers = Math.min(
    options.pool?.maxWorkers ?? defaultMaxWorkers(),
    factory.maxWorkers ?? Number.POSITIVE_INFINITY,
  )
  const recycle: RecyclePolicy = {
    ...options.pool?.recycle,
    memoryLimitBytes:
      options.pool?.recycle?.memoryLimitBytes ?? defaultWorkerMemoryLimit(maxWorkers),
  }
  const fileTimeoutMs = options.pool?.fileTimeoutMs
  return {
    factory,
    poolOptions: {
      kind,
      maxWorkers,
      recycle,
      teardownTimeoutMs,
      startTimeoutMs,
      ...(fileTimeoutMs === undefined ? {} : { fileTimeoutMs }),
    },
  }
}

/**
 * Runs a project's test files and reports to the bus, and resolves with the summary: `runProjects`
 * over one project.
 *
 * A bad option rejects (`ORCH_BAD_PATTERN`, `ORCH_NOT_IMPLEMENTED`, a bad worker entry) before the
 * bus hears of the run. A run that finds no files emits `run:start` and `run:end` and nothing
 * between. Otherwise: `run:start`, a `file:queued` per file in the sequencer's order, the files
 * through the pool, and `run:end` once every worker has exited and the cache is written.
 *
 * **Every `file:start` is followed by exactly one `file:end`, and a `file:end` never comes without
 * its `file:start`.** A file that is cut off by an abort gets its `file:end` (a failure) and is in
 * the summary; one that had not started gets neither event and is not in it. `summary.files` is in
 * queue order, `unhandled` holds every unhandled error of the run, and `reason` is `interrupted`
 * after an abort, else `failed` when a file failed or (with `fail-run`) an error went unhandled.
 *
 * If something throws after `run:start`, the pool is closed, the bus gets `error(…, 'coordinator')`
 * and a `run:end` with `reason: 'failed'`, and the error propagates.
 * @public
 */
export function runProject(
  project: ResolvedProject,
  options: RunProjectOptions,
): Promise<RunSummary> {
  return runProjects([project], options)
}

/**
 * Runs several projects through one pool (D29, as Jest's `projects` do): one bus, one `maxWorkers`
 * for the whole run, one `run:start` and one `run:end`. Each worker is bound to one project at
 * `WorkerInit` (its config, environment and isolation), so a file goes to a worker of its own
 * project. The files are queued project by project in the config's order, each project's by the
 * sequencer, so workers change project only at a boundary; a worker whose project has no file left
 * is stopped as soon as it is idle (the pool's `drain`), or when a file of another project needs
 * its slot. Everything else is `runProject`'s: the pattern, the results cache (one history per
 * project), the snapshot mode, the file filters, abort, the pairing of `file:start` and `file:end`.
 *
 * What is run-wide takes the first project's value: the pool kind, `unhandledErrors`, the exit
 * policy and the snapshot summary's mode.
 * @public
 */
export function runProjects(
  projects: readonly ResolvedProject[],
  options: RunProjectOptions,
): Promise<RunSummary> {
  return runProjectsOn(projects, options, undefined)
}

/**
 * `runProjects`, on a watch session's pool when `host` is given (B23c): the pool is the session's,
 * kept warm after the run, and the run is never put in band by itself (Jest's `shouldRunInBand`
 * says no under `--watch`, testSchedulerHelper.ts L36-38).
 * @internal
 */
export async function runProjectsOn(
  projects: readonly ResolvedProject[],
  options: RunProjectOptions,
  host: RunHost | undefined,
): Promise<RunSummary> {
  const { bus, signal } = options
  const [first] = projects
  if (first === undefined) {
    throw new OrchestratorError('ORCH_NO_PROJECTS', 'A run needs at least one project.')
  }
  const { orchestrator } = first.policy
  for (const project of projects) {
    checkPattern(options.testNamePattern, project.policy.core.testNamePatternFlags)
  }
  // The pool kind the options and the policy ask for. A run that goes in band is decided once the
  // files are known (below): `kind` is then `inline`, the pool is made again, and the workers' keys
  // are made against it.
  let kind: PoolKind = host?.kind ?? options.pool?.kind ?? orchestrator.pool.default
  /** The run is in band by choice (not an `inline` pool a caller asked for): its console is captured. */
  let inBandChosen = host?.inBand ?? false
  const execArgv = options.pool?.execArgv
  const { bail } = options
  if (bail !== undefined && !(Number.isSafeInteger(bail.count) && bail.count >= 1)) {
    throw new OrchestratorError(
      'ORCH_BAD_OPTION',
      `bail.count (the failed tests that end the run) must be a whole number of at least 1 (got ${String(bail.count)})`,
    )
  }
  const bailAfter = orchestrator.bail.checkAfter
  if (options.shard !== undefined) checkShard(options.shard)
  if (options.shard !== undefined && options.timings?.update === true) {
    throw new OrchestratorError(
      'ORCH_BAD_OPTION',
      '--update-timings can’t be used together with --shard: shards that run one after another in one checkout would read the timings the last one wrote, cut the files differently, and run some twice and some never. Refresh the timings file on an unsharded run',
    )
  }

  const { detectLeaks } = options
  if (detectLeaks !== undefined && projects.some((p) => p.isolation === 'none' && detectLeaks(p))) {
    throw new OrchestratorError(
      'ORCH_BAD_OPTION',
      'detectLeaks can’t be used with isolation `none`: its files share one module registry and one environment for the worker’s life, so nothing is released after a file to check. Use isolation `registry` or `process`',
    )
  }

  // Coverage is the projects' own (their worker config says which files count); the run keeps
  // what the workers send. Its modules (and `@provino/coverage/node` behind them) load only when a
  // project collects (T1.10, T7.12): a run without coverage imports none of them.
  const coverageStore = projects.some((project) => project.config.coverage !== undefined)
    ? (await import('./coverage-store.ts')).createRawCoverageStore()
    : undefined
  /** Keeps a worker's `coverage` event, and hands the take to `onTake`. */
  const keepCoverage = (
    workerId: number,
    event: Extract<WorkerEvent, { readonly type: 'coverage' }>,
  ): void => {
    if (coverageStore === undefined) return
    // Kept first: with no `onTake` the optional call would skip its argument.
    const take = coverageStore.add(workerId, event)
    options.coverage?.onTake?.(take)
  }

  const caches = host?.caches ?? new Map<string, ResultsCache>()
  const cacheFor = (project: ResolvedProject): ResultsCache | undefined => {
    if (options.cache === false) return undefined
    if (options.cache !== undefined) return options.cache
    const directory = cacheDirectories(project).results
    let cache = caches.get(directory)
    if (cache === undefined) {
      cache = createResultsCache(directory)
      caches.set(directory, cache)
    }
    return cache
  }
  // One seed for the run (`jest.getSeed()`): a project that gives none takes this one, so every
  // worker of every such project reports the same value, as Jest's single `globalConfig.seed`.
  const runSeed = host?.seed ?? Math.floor(0x1_0000_0000 * Math.random()) - 0x8000_0000
  /** Each lockfile's hash by path, so projects that share a lockfile read it once. */
  const lockfileHashes = host?.lockfileHashes ?? new Map<string, string>()
  // Two projects can share a name, yet differ in discovery, environment, transform or setup files;
  // each still needs a worker key, a file-id namespace and a results history of its own.
  const takenIdentities = new Set<string>()
  const nameCounts = Map.groupBy(projects, (project) => project.name)
  const cacheKeyCounts = Map.groupBy(projects, projectCacheKey)
  /** Each package directory's `version`, read once per run for the learned externals (D127). */
  const packageVersions = new Map<string, string>()
  const members: Member[] = projects.map((resolved, index) => {
    // The transform cache (T3.6) is on unless the run has no cache (`--no-cache`): the directory is
    // wiped here if the lockfile changed, and handed to the project's workers.
    const cached =
      options.cache === false
        ? resolved
        : withTransformCache(resolved, cacheDirectories(resolved).transform, lockfileHashes)
    const cache = cacheFor(cached)
    const seeded: SeededProject = {
      ...cached,
      config: { ...cached.config, seed: cached.config.seed ?? runSeed },
    }
    // The identity is taken before the learned externals go into the config, so it, and a shared
    // key's history, is the same in the run that learned them and the next one, which reads them.
    const base =
      nameCounts.get(seeded.name)?.length === 1
        ? seeded.name
        : `${seeded.name}#${configHash(seeded.config).slice(0, 8)}`
    const identity = takenIdentities.has(base) ? `${base}@${index}` : base
    takenIdentities.add(identity)
    const cacheKey = projectCacheKey(seeded)
    // The results history keeps its stable key, so editing a config doesn't lose it, unless
    // another project of the run has the same one.
    const cacheProject = cacheKeyCounts.get(cacheKey)?.length === 1 ? cacheKey : identity
    const project: SeededProject = {
      ...seeded,
      config: {
        ...seeded.config,
        loader: withLearnedExternals(seeded, cache, cacheProject, packageVersions),
      },
    }
    return {
      project,
      cacheProject,
      identity,
      projectIndex: index,
      // Asked of the project the caller gave: `project` above is a copy of it.
      detectLeaks: options.detectLeaks?.(resolved) === true,
      // What every file does with its snapshots (build-plan §6: the worker writes the `.snap` files).
      snapshots: snapshotMember(
        resolveUpdateMode({
          update: options.update ?? false,
          ci: project.config.ci,
          env: options.env ?? process.env,
          policy: project.policy.snapshot,
        }),
        project.policy.snapshot,
      ),
      cache,
      keyInput: {
        project: identity,
        pool: kind,
        environment: project.environment,
        environmentOptions: project.config.environment.options,
        execArgv: execArgv ?? process.execArgv,
      },
      keys: new Map(),
    }
  })
  const byIdentity = new Map(members.map((member) => [member.identity, member]))
  const snapshotMembers = members.map((member) => member.snapshots)
  const inlineWrites = createInlineSnapshotWrites()

  const startedAt = performance.now()
  const stderr = options.stderr ?? process.stderr
  const unhandled: SerializedError[] = []
  /** Global setup, once it has run (T9.15): its teardown comes after the run, whatever ends it. */
  let globalSetup: GlobalSetupRun | undefined
  /** The run ended in an error, so a failing teardown must not replace it. */
  let thrown = false
  /** Per worker, the file it ran last and when that file's `file:end` has been emitted. */
  const lastFile = new Map<number, { readonly info: FileInfo; readonly ended: Promise<void> }>()
  /** Per worker, the module paths its `deps` events have named: the ids are the worker's for its life. */
  const depsTables = host?.depsTables ?? new Map<number, DepsTable>()
  // Nothing starts until a file is run, but this is where a bad option throws (`recycle`, the
  // transport's own entry), so it comes before `run:start`. A run that then goes in band makes the
  // pool again, as an inline one: the first has started nothing. A watch session's run binds the
  // session's pool instead.
  function makePool(poolKind: PoolKind): Pool {
    const deps = poolDeps(poolKind)
    if (host !== undefined) return host.attach(deps)
    const { factory, poolOptions } = poolSettings(options, poolKind)
    return createPool(poolOptions, { ...deps, transport: () => factory })
  }

  /** What the pool asks of this run: a worker's init, the coordinator methods, the run's signals. */
  function poolDeps(poolKind: PoolKind): RunPoolDeps {
    return {
      init: (workerKey, workerId) => {
        // A worker is bound to the project its key names, for its whole life.
        const member = byIdentity.get(workerKey.project)
        if (member === undefined) {
          throw new Error(`no project of this run is called ${JSON.stringify(workerKey.project)}`)
        }
        return {
          key: workerKey,
          workerId,
          isolation: workerKey.isolation,
          // What global setup's `provide` collected; a worker starts only once setup has run.
          provided: globalSetup?.provided ?? {},
          config: member.project.config,
          // A worker started after others sent their V8 modules sends none of those again.
          ...(coverageStore === undefined || coverageStore.v8Modules.size === 0
            ? {}
            : { coverageModules: [...coverageStore.v8Modules] }),
          ...(poolKind === 'inline' && inBandChosen ? { captureConsole: true as const } : {}),
        }
      },
      methods: {
        readTimings: (file) => {
          for (const member of members) {
            const duration = member.cache?.get(
              member.cacheProject,
              relativePosix(member.project.rootDir, resolve(member.project.rootDir, file)),
            )?.durationMs
            if (duration !== undefined) return duration
          }
          return undefined
        },
      },
      onIdleEvents: idleEvents(),
      onError: (error, errorKind) => {
        // Late output that couldn't be handed to the bus, or a worker that ended badly with no file
        // to blame: errors of the run, not of a file (a lost worker also fails the run).
        if (errorKind === 'worker-lost') unhandled.push(serializeError(error))
        void bus.emit('error', serializeError(error), 'coordinator')
      },
      ...(signal === undefined ? {} : { signal }),
      ...(options.forceSignal === undefined ? {} : { forceSignal: options.forceSignal }),
    }
  }
  let pool = makePool(kind)

  /** What a worker sends while it stops reaches the bus under its last file, after that file's `file:end`. */
  function idleEvents(): (workerId: number, events: readonly WorkerEvent[]) => Promise<void> {
    const dispatch = createIdleDispatch({
      bus,
      fileOf: (workerId) => lastFile.get(workerId)?.info,
      onUnhandled: (error) => void unhandled.push(error),
      ...(coverageStore === undefined ? {} : { onCoverage: keepCoverage }),
    })
    return async (workerId, events) => {
      // A worker is retired once its last file is done, and its stop-time events must still follow
      // that file's `file:end`. Today they always do (they arrive over IPC, a macrotask, and
      // `runFile` emits `file:end` within microtasks of `pool.run` settling), so this wait is a
      // guard for an `await` added there later, not something a test can reach now.
      await lastFile.get(workerId)?.ended
      await dispatch(workerId, events)
    }
  }

  /** Per project, the modules its test files loaded (`affected.graph: 'recorded-then-static'`). */
  let recorded: ReadonlyMap<Member, RecordedGraph> = new Map()
  /** A run whose files run only some of their tests (`-t`) or none (`--collectTests`). */
  const partialRun =
    options.collectOnly === true ||
    (options.testNamePattern !== undefined && options.testNamePattern !== '')
  /** Where a project keeps its affected-test caches: none under `--no-cache`. */
  const affectedCacheDir = (member: Member): string | null =>
    options.cache === false ? null : cacheDirectories(member.project).results

  /** The result of each queued file that has one. */
  const results = new Map<QueuedFile, FileResult>()
  /** The time of each file that ran to its end, by the path the timings file knows it by (`--update-timings`). */
  const measured = new Map<string, number>()
  let queue: readonly QueuedFile[] = []
  let interrupted = false
  let announced = false
  /** The run ends by throwing before its reporters are told it ended (Jest dispatches no `onRunComplete`). */
  let endUnreported = false
  /** `--bail`: the failed tests counted so far, and whether the count has ended the run. */
  let failedTests = 0
  let bailed = false
  /** What an aborted `signal` means: the signal its reason names (`RUN_SIGNALS`), else an interruption. */
  const cutShort = (): RunEndReason => {
    const named: unknown = signal?.reason
    return isRunSignal(named) ? RUN_SIGNALS[named].reason : RUN_SIGNALS.SIGINT.reason
  }
  /** Adds failed tests to the run's count, and ends the run if that reaches `bail.count`. */
  function countFailed(count: number): void {
    failedTests += count
    checkBail()
  }
  /** Reached `bail.count`: no more files start, and under Jest's rule the running ones are killed. */
  function checkBail(): void {
    if (bail === undefined || bailed || failedTests < bail.count) return
    bailed = true
    pool.cancelQueued()
    // A file already running can't be cancelled before T5.12: Jest's rule (checked after each
    // file) kills it, as Jest's own exit does; Vitest's (after each test) lets it end.
    if (bailAfter === 'file') void pool.close()
  }
  let handles: OpenHandleTracker | undefined
  /** Each queued file's run, once every file has been asked for. */
  let running: readonly Promise<void>[] = []

  /** The files that have a result, in queue order. */
  const finishedFiles = (): FileResult[] => queue.flatMap((entry) => results.get(entry) ?? [])

  const summarize = (
    reason: RunSummary['reason'],
    openHandles: readonly OpenHandle[] = [],
    coverage?: CoverageSummary,
  ): RunSummary => {
    const run = mergedSnapshots(snapshotMembers)
    return {
      reason,
      files: finishedFiles(),
      unhandled,
      durationMs: performance.now() - startedAt,
      ...(run === undefined
        ? {}
        : { snapshots: run, snapshotsFail: snapshotsFailRun(snapshotMembers) }),
      ...(openHandles.length === 0 ? {} : { openHandles }),
      ...(coverage === undefined ? {} : { coverage }),
    }
  }

  /** One file, from its turn in the queue to its `file:end`. */
  async function runFile(entry: QueuedFile): Promise<void> {
    const { member } = entry
    /** This file's failed tests: added to the run's count as they fail, or when the file ends. */
    let failedInFile = 0
    /** The worker that took the file (set by `onStart`, before any of its events). */
    let takenBy = -1
    const dispatch = createFileDispatch({
      bus,
      file: entry.info,
      onUnhandled: (error) => void unhandled.push(error),
      ...(coverageStore === undefined
        ? {}
        : { onCoverage: (event) => keepCoverage(takenBy, event) }),
      onTestFailed: () => {
        failedInFile++
        if (bailAfter === 'test') countFailed(1)
      },
      depsTable: () => {
        let table = depsTables.get(takenBy)
        if (table === undefined) {
          table = createDepsTable()
          depsTables.set(takenBy, table)
        }
        return table
      },
    })
    const job: FileJob = {
      file: entry.file.path,
      fileId: entry.info.fileId,
      updateSnapshots: member.snapshots.update,
      ...(options.collectOnly === true ? { collectOnly: true as const } : {}),
      ...(member.detectLeaks ? { detectLeaks: true as const } : {}),
      ...(options.logHeapUsage === true ? { logHeapUsage: true as const } : {}),
      ...(options.testNamePattern === undefined
        ? {}
        : { testNamePattern: options.testNamePattern }),
    }
    let takenAt: number | undefined
    /** When a worker took the file, on the wall clock: what its recorded graph is stamped with. */
    let takenAtWall: number | undefined
    const ended = Promise.withResolvers<void>()
    try {
      const polled = await pool.run({
        key: entry.key,
        job,
        onStart: async (workerId) => {
          takenBy = workerId
          takenAt = performance.now()
          takenAtWall = Date.now()
          lastFile.set(workerId, { info: entry.info, ended: ended.promise })
          await bus.emit('file:start', entry.info, workerId)
        },
        onEvents: dispatch.handle,
        ...(host === undefined ? {} : { staleModules: host.staleModules }),
        // Jest's rule counts a file's failed tests when the file ends: before its worker takes
        // another file, or `--bail` would start one it is about to give up.
        // A file the worker found leaking is failed whole and its tests are discarded (Jest's
        // `onFailure`, which adds no failed test and never checks `bail`), so they count for none.
        onDone: (done) => {
          if (bailAfter === 'file') countFailed(done.leaks === true ? 0 : failedInFile)
        },
      })
      // The file's inline snapshots go into the source before it is reported (D113).
      const outcome = await withInlineSnapshots(
        polled,
        inlineWrites,
        {
          rootDir: member.project.rootDir,
          policy: member.project.policy.snapshot,
          update: member.snapshots.update,
        },
        (text) => void stderr.write(`${text}\n`),
      )
      if (outcome.type === 'aborted') {
        // The run's own bail cut this file short: Jest reports no result for a file it kills, so
        // neither do we (the one exception to `file:start` having a `file:end`). A signal that
        // came too is the stronger reason.
        if (bailed && signal?.aborted !== true) return
        interrupted = true
        // A watch run's interrupt (a key during it: the session's signal) and the policy's `drop`:
        // the killed file reports no result, as Jest's watcher ignores one once it is interrupted
        // (it keeps its `file:start`: a reporter drops it at the next `run:start`, see CLAUDE.md).
        if (host !== undefined && orchestrator.watch.interruptedFiles === 'drop') return
        // A file that never started was never announced as started: nothing to end.
        if (takenAt === undefined) return
      }
      if (outcome.type === 'start-failed') {
        // No worker took the file, but a `file:end` always has a `file:start` before it: this one
        // names the worker whose failed start the file's error is.
        await bus.emit('file:start', entry.info, outcome.workerId)
      }
      if (outcome.type === 'done' && outcome.done.snapshot !== undefined) {
        entry.member.snapshots.aggregate.add(outcome.done.snapshot, entry.file.path)
      }
      const elapsedMs = takenAt === undefined ? 0 : performance.now() - takenAt
      const reported = resultOf(entry.info, outcome, dispatch.result, elapsedMs, {
        ended: dispatch.todo,
        collected: dispatch.tests,
        runnerFailed: dispatch.runnerFailed,
        todoOnlyFile: member.project.policy.orchestrator.todoOnlyFile,
        failsWithNoTests: failsWithNoTests(
          member.project.policy.orchestrator,
          options.passWithNoTests,
        ),
      })
      // The worker finished the file and the inline snapshot write failed it.
      const result: FileResult =
        outcome.type === 'done' && outcome.done.leaks === true
          ? leakedResult(reported)
          : outcome !== polled
            ? { ...reported, resultsDiscarded: true }
            : reported
      // A start failure or an interruption says nothing about the file; a skipped file isn't
      // remembered (as Jest's).
      if (
        outcome.type !== 'start-failed' &&
        outcome.type !== 'aborted' &&
        result.state !== 'skip'
      ) {
        member.cache?.record(member.cacheProject, entry.info.path, {
          durationMs: result.durationMs,
          failed: result.state === 'fail',
          tests: dispatch.tests,
          at: Date.now(),
        })
      }
      // What the worker learned to evaluate per file (D127), for the next run's workers.
      if (
        outcome.type === 'done' &&
        outcome.done.reevaluated !== undefined &&
        member.cache !== undefined
      ) {
        learnExternals(
          member.cache,
          member.cacheProject,
          member.project.rootDir,
          outcome.done.reevaluated,
          packageVersions,
        )
      }
      // A record is the file's whole closure only when every test ran: a test `-t`, `.only` or
      // `.skip` left out may load what the others don't, and an older, whole record is kept. It is
      // stamped with the time the file was taken, so a save while it ran makes it stale.
      if (
        outcome.type === 'done' &&
        dispatch.deps !== undefined &&
        result.state !== 'skip' &&
        !partialRun &&
        dispatch.skipped === 0 &&
        takenAtWall !== undefined
      ) {
        recorded.get(member)?.record(entry.file.path, dispatch.deps, takenAtWall)
      }
      results.set(entry, result)
      // A time is a measurement only when the file ran to its end: a crash, a kill and a failed
      // start say nothing about how long it takes.
      if (outcome.type === 'done') measured.set(entry.timingsPath, result.durationMs)
      await bus.emit('file:end', result)
    } finally {
      ended.resolve()
    }
  }

  /** Writes the history; it is a convenience, so a failure is a line on `stderr`, never a rejection. */
  async function writeCache(): Promise<void> {
    if (options.collectOnly === true) return
    try {
      const written = new Set(members.flatMap((member) => member.cache ?? []))
      await Promise.all([
        ...[...written].map((cache) => cache.write()),
        ...[...recorded.values()].map((graph) => graph.save()),
      ])
    } catch (error) {
      // A read-only directory must not fail a run that passed.
      stderr.write(`Provino: could not write the results cache: ${messageOf(error)}\n`)
    }
  }

  /**
   * `--update-timings`: this run's file times into the timings file. Like the results cache it is a
   * convenience a failing disk must not turn into a failed run, so a failure is a line on `stderr`.
   * The file is read again here, so a run that wrote in the meantime keeps its entries.
   */
  async function writeTimingsFile(
    file: string,
    seen: ReadonlySet<string> | undefined,
  ): Promise<void> {
    try {
      let existing: TimingsFile | undefined
      try {
        existing = await readTimings(file)
      } catch (error) {
        // A file this run replaces: say so, and write the new one.
        stderr.write(`Provino: replacing the timings file: ${messageOf(error)}\n`)
      }
      await writeTimings(file, mergeTimings(existing, measured, seen))
    } catch (error) {
      stderr.write(`Provino: could not write the timings file: ${messageOf(error)}\n`)
    }
  }

  /**
   * Eviction by size is the coordinator's, after the run (Track 3 R5). It runs once the reporters
   * have the summary, so nothing waits on it, and it skips a directory no worker wrote to.
   */
  function pruneTransformCaches(): void {
    const directories = new Set(
      members.flatMap((member) => member.project.config.loader.cacheDir ?? []),
    )
    for (const directory of directories) pruneTransformCache(directory)
  }

  try {
    const cwd = resolve(options.cwd ?? process.cwd())
    const runRoot = options.root ?? first.rootDir
    const { shard } = options
    const timingsFile = resolve(cwd, options.timings?.file ?? join(runRoot, TIMINGS_FILE_NAME))
    // A shard cuts by the timings file, so a file that is there and wrong stops the run: shards that
    // read it differently would drop test files between them.
    const timings = shard === undefined ? undefined : await readTimings(timingsFile)
    // What each test file loaded, for the projects whose policy selects by it (the neutral one).
    const recordedGraphs = new Map<Member, RecordedGraph>()
    for (const member of members) {
      const cacheDir = affectedCacheDir(member)
      if (
        cacheDir !== null &&
        member.project.policy.orchestrator.affected.graph === 'recorded-then-static'
      ) {
        recordedGraphs.set(
          member,
          await (host?.openRecordedGraph ?? openRecordedGraph)(
            affectedCachePaths(cacheDir, member.cacheProject).deps,
          ),
        )
      }
    }
    recorded = recordedGraphs
    const everyFile = await Promise.all(
      members.map(async (member) => {
        const everything = await discoverProject(member.project)
        // A selection takes the place of the file filters (Jest ignores path patterns in related mode).
        const selected =
          options.selection === undefined
            ? selectFiles(everything, options.fileFilters ?? [], {
                rootDir: member.project.rootDir,
                cwd,
              })
            : host !== undefined
              ? await host.selectAffected(
                  member,
                  everything,
                  options.selection,
                  recordedGraphs.get(member),
                )
              : await selectAffected(
                  member,
                  everything,
                  options.selection,
                  affectedCacheDir(member),
                  recordedGraphs.get(member),
                )
        // The project's own filter (`--filter`) takes either, as Jest filters the tests it found.
        const own = projects[member.projectIndex]
        const discovered =
          options.fileFilter === undefined || own === undefined
            ? selected
            : await options.fileFilter(own, selected)
        return { member, everything, discovered }
      }),
    )
    // Jest shards the one list of every project's files, after the file filters.
    const shards =
      shard === undefined
        ? undefined
        : shardFiles(
            everyFile.map(({ member, discovered }) => ({
              rootDir: member.project.rootDir,
              files: discovered,
            })),
            { shard, fallback: orchestrator.shard.fallback, runRoot, timings },
          )
    // `onlyFailures` comes after the shard and the sort in Jest; as a filter it commutes with the sort.
    const found = everyFile.map((entry, index) => {
      const sharded = shards?.[index] ?? entry.discovered
      return {
        ...entry,
        discovered:
          options.onlyFailures === undefined
            ? sharded
            : keepFailed(entry.member, sharded, options.onlyFailures),
      }
    })
    for (const [member, graph] of recordedGraphs) {
      const everything = everyFile.find((entry) => entry.member === member)?.everything ?? []
      graph.prune(
        new Set(everything.map((file) => join(member.project.rootDir, file.relativePath))),
      )
    }
    // Whether the files run in this process, now that the run's files are known (Jest's
    // `shouldRunInBand`, from the policy's numbers): the pool is made again as an inline one.
    const inBand = shouldRunInBand({
      // A caller that names `forks` or `threads` has chosen, unless it says the kind is only for a
      // run that is not in band: only `runInBand` and `detectOpenHandles` move it into this process.
      policy:
        (options.pool?.automaticInBand ?? options.pool?.kind === undefined)
          ? orchestrator.inBand
          : NO_AUTOMATIC_IN_BAND,
      ...(options.runInBand === true ? { runInBand: true } : {}),
      ...(options.detectOpenHandles === true ? { detectOpenHandles: true } : {}),
      ...(host === undefined ? {} : { watch: true }),
      workerMemoryLimit: options.pool?.recycle?.memoryLimitBytes !== undefined,
      maxWorkers: options.pool?.maxWorkers ?? defaultMaxWorkers(),
      fileCount: found.reduce((sum, entry) => sum + entry.discovered.length, 0),
      timingsMs: found.flatMap(({ member, discovered }) =>
        discovered.flatMap((file) => {
          const time = member.cache?.get(member.cacheProject, file.relativePath)?.durationMs
          return time === undefined || time === 0 ? [] : [time]
        }),
      ),
    })
    // A session's pool is its own for every run: its kind was decided when it was made.
    if (inBand && kind !== 'inline' && host === undefined) {
      await pool.close()
      kind = 'inline'
      inBandChosen = true
      pool = makePool(kind)
      for (const member of members) {
        member.keyInput = { ...member.keyInput, pool: kind }
        member.keys.clear()
      }
    } else if (inBand) {
      inBandChosen = options.runInBand === true || options.detectOpenHandles === true
    }
    // Each file's worker key: its project's at the tier its docblock or history asks for (T2.11).
    const keys = await Promise.all(
      found.map(({ member, discovered }) =>
        keysOf(member, discovered, (warning) => stderr.write(`Provino: warning: ${warning}\n`)),
      ),
    )
    const info: RunInfo = {
      root: runRoot,
      projects: projects.map((project) => project.name),
      startTime: startedAt,
      watch: host !== undefined,
      inBand: kind === 'inline',
    }
    if (found.every((entry) => entry.discovered.length === 0)) {
      announced = true
      await bus.emit('run:start', info, [])
      await pool.close()
      const cut = signal?.aborted === true
      // Jest still schedules an empty run when `--passWithNoTests` lets it go on, so its
      // CoverageReporter writes the reports of an empty map and checks the thresholds over it
      // (runJest.ts L338-L352, `coverage/threshold-no-tests`): a group that names a path or a glob
      // finds no data, and the run fails. Without the flag Jest ends before it schedules anything
      // (`threshold-no-tests-no-flag`). No project had a file, so none is added as untested.
      const coverage =
        coverageStore === undefined || cut || options.coverage?.reportEmptyRun !== true
          ? undefined
          : await (await import('./coverage.ts')).finishCoverage(
              coverageStore,
              [],
              options.coverage,
              members[0]?.project,
            )
      const summary = summarize(
        cut ? cutShort() : (coverage?.thresholdFailures.length ?? 0) > 0 ? 'failed' : 'passed',
        [],
        coverage,
      )
      await bus.emit('run:end', summary)
      return summary
    }

    // Project by project, in the config's order: workers change project only at a boundary.
    queue = qualifyDuplicatePaths(
      found.flatMap(({ member, everything, discovered }, index) =>
        planQueue(member, everything, discovered, runRoot, keys[index] ?? new Map()),
      ),
    )

    // Jest's order: the files are known, the setup runs, then the reporters hear the run start. A
    // project with no file to run has no setup (Jest's `allTests` only holds projects with tests).
    // A run that was interrupted before this point sets nothing up: the pool never starts a file,
    // and the run ends with the signal's reason, as it would one moment later.
    if (signal?.aborted !== true && options.collectOnly !== true) {
      globalSetup = await runGlobalSetup(sequencedProjects(found, options.globalSetup), {
        hooks: options.globalSetup,
        signal,
        forceSignal: options.forceSignal,
      })
    }
    host?.onProvided(globalSetup?.provided ?? {})

    announced = true
    await bus.emit(
      'run:start',
      info,
      queue.map((entry) => entry.info),
    )
    for (const entry of queue) await bus.emit('file:queued', entry.info)

    // `runFile` asks the pool for its worker before its first `await`, so every file is requested
    // by the time `drain` runs: from here on an idle worker has nothing to wait for.
    if (options.detectOpenHandles === true) {
      handles = collectOpenHandles({ roots: members.map((m) => m.project.rootDir) })
    }
    running = queue.map((entry) => runFile(entry))
    pool.drain()
    await Promise.all(running)
    // The history is complete; writing it overlaps the workers' shutdown.
    await Promise.all([pool.close(), writeCache()])
    // Each project's snapshot files that no test file has, as Jest's scheduler finds them once
    // every file ran (DV96); a collect-only pass or an interrupted run looks for none. Only a
    // project with a selected file is cleaned: `scheduleTests` builds its contexts from the tests
    // it is given (TestScheduler L124-L127, L204-L224), so a path filter or a shard that leaves a
    // project no file leaves its orphan snapshot files alone, under `-u` too.
    if (options.collectOnly !== true && !interrupted && signal?.aborted !== true) {
      // Every resolver is built before any project is cleaned, and one that fails ends the run
      // with its error, as `updateSnapshotState` does.
      const cleanups = await Promise.all(
        found.flatMap(({ member, discovered }) =>
          discovered.length === 0
            ? []
            : [
                prepareObsoleteSnapshotCleanup(member.project, member.snapshots.update).then(
                  (clean) => ({ member, clean }),
                  (error: unknown) => {
                    // `scheduleTests` throws here, before it dispatches `onRunComplete`: the files'
                    // results are out, the reporters hear no totals, and the error is the run's.
                    endUnreported = true
                    throw error
                  },
                ),
              ],
        ),
      )
      for (const { member, clean } of cleanups) member.snapshots.removed.push(...clean())
    }
    // A `-t` run executes only the matching tests of each file, so its durations are not the files'.
    const partial = options.testNamePattern !== undefined && options.testNamePattern !== ''
    if (options.timings?.update === true && options.collectOnly === true) {
      // Nothing ran: a collect-only pass's durations are not the files' and would skew the shards.
    } else if (options.timings?.update === true && partial) {
      stderr.write(
        'Provino: not updating the timings file: -t runs only some of each file’s tests, so the times are not the files’ times\n',
      )
    } else if (options.timings?.update === true) {
      // Dropping the entries of files that are gone is only right for a run that saw every file.
      const sawAll = shard === undefined && (options.fileFilters ?? []).length === 0
      await writeTimingsFile(
        timingsFile,
        sawAll
          ? new Set(
              found.flatMap(({ member, everything }) =>
                everything.map((file) =>
                  relativePosix(runRoot, join(member.project.rootDir, file.relativePath)),
                ),
              ),
            )
          : undefined,
      )
    }
    // After the last worker has stopped: what it could not clean up is what is left.
    const openHandles = (await handles?.collect()) ?? []
    handles = undefined

    const failed =
      bailed ||
      finishedFiles().some((file) => file.state === 'fail') ||
      snapshotsFailRun(snapshotMembers) ||
      (orchestrator.unhandledErrors === 'fail-run' && unhandled.length > 0)
    // A signal that came while the run was winding down (the pool closing, the cache being written,
    // the open handles being collected) leaves no file in the middle of anything, but it is still
    // the user's interruption: the summary says so, and the exit code is the signal's.
    const cut = interrupted || signal?.aborted === true
    // Jest's CoverageReporter reports at the end of a run that was not interrupted, over the
    // projects that had a file to run (`_addUntestedFiles`' test contexts).
    const coverage =
      coverageStore === undefined || cut
        ? undefined
        : await (await import('./coverage.ts')).finishCoverage(
            coverageStore,
            found
              .filter((entry) => entry.discovered.length > 0)
              .map((entry) => entry.member.project),
            options.coverage,
          )
    const summary = summarize(
      cut
        ? cutShort()
        : failed || (coverage?.thresholdFailures.length ?? 0) > 0
          ? 'failed'
          : 'passed',
      openHandles,
      coverage,
    )
    await bus.emit('run:end', summary)
    pruneTransformCaches()
    return summary
  } catch (error) {
    thrown = true
    await pool.close()
    // A session's pool doesn't wait for the files it killed: each still ends (its `file:end`)
    // before the reporters hear the run ended, and none reaches the session's next run.
    if (host !== undefined) await Promise.allSettled(running)
    // The hook that tracks resources is process-wide: it must not outlive the run.
    handles?.dispose()
    // Reporters that heard `run:start` hear how it ended, whatever threw.
    if (announced && !endUnreported) {
      try {
        await bus.emit('error', serializeError(error), 'coordinator')
        await bus.emit('run:end', summarize('failed'))
      } catch (reportFailure) {
        stderr.write(
          `Provino: could not report the failure to the reporters: ${messageOf(reportFailure)}\n`,
        )
      }
    }
    throw error
  } finally {
    // After the reporters have the summary (or the run failed), in the policy's order. A teardown
    // that throws fails a run that didn't; after a failure it is only a line on `stderr`.
    try {
      await globalSetup?.teardown()
    } catch (error) {
      // biome-ignore lint/correctness/noUnsafeFinally: the point: a teardown that fails replaces the summary of a run that ended well, and after a failed run it must not replace that run's own error
      if (!thrown) throw error
      stderr.write(`Provino: global teardown failed: ${messageOf(error)}\n`)
    }
  }
}

/** The sequencer a project's policy asks for. */
function sequencerFor(project: ResolvedProject) {
  return createHistorySequencer({
    unknownFirst: project.policy.orchestrator.sequence.unknownFirst,
    shardFallback: project.policy.orchestrator.shard.fallback,
  })
}

/**
 * What the sequencer reads of a discovered file: its path, its size and its history. `key` names
 * the project the file belongs to, which the order breaks ties by.
 */
function scheduleInputOf(member: Member, file: DiscoveredFile, key: string): ScheduleInput {
  const history = member.cache?.get(member.cacheProject, file.relativePath)
  return {
    path: file.relativePath,
    project: key,
    sizeBytes: file.sizeBytes,
    ...(history === undefined ? {} : { history }),
  }
}

/** Whether `hooks` names a setup or a teardown module. */
function hasHooks(hooks: RunGlobalHooks | undefined): boolean {
  return hooks !== undefined && (hooks.setup.length > 0 || hooks.teardown.length > 0)
}

/**
 * The projects that have a file to run, in the order Jest's one sorted list of every project's
 * files reaches them (`allTests` after `sequencer.sort`, which `runGlobalHook` reads): the run's
 * global setup follows it, and so does which project's config a hook several share gets. The
 * queue itself goes project by project; this order is only for the hooks, so it is worked out
 * only when there are hooks and more than one project to put in order.
 */
function sequencedProjects(
  found: readonly { readonly member: Member; readonly discovered: readonly DiscoveredFile[] }[],
  runHooks: RunGlobalHooks | undefined,
): SeededProject[] {
  const withFiles = found.filter((entry) => entry.discovered.length > 0)
  const [first] = withFiles
  if (first === undefined) return []
  if (
    withFiles.length < 2 ||
    !(hasHooks(runHooks) || withFiles.some(({ member }) => hasHooks(member.project.globalSetup)))
  ) {
    return withFiles.map(({ member }) => member.project)
  }
  const inputs: ScheduleInput[] = withFiles.flatMap(({ member, discovered }) =>
    discovered.map((file) => scheduleInputOf(member, file, member.identity)),
  )
  const sorted = sequencerFor(first.member.project).sort(inputs)
  const byIdentity = new Map(withFiles.map(({ member }) => [member.identity, member.project]))
  return [...new Set(sorted.map((input) => input.project))].flatMap(
    (identity) => byIdentity.get(identity) ?? [],
  )
}

/** The worker key of `member`'s files at `tier`: made once per tier. */
function keyFor(member: Member, tier: IsolationTier): WorkerKey {
  let key = member.keys.get(tier)
  if (key === undefined) {
    key = workerKeyOf({ ...member.keyInput, isolation: tier })
    member.keys.set(tier, key)
  }
  return key
}

/**
 * Each file's worker key, by its path: the project's isolation tier, raised by what the file's
 * docblock asks for (`@provino-isolate`) or an earlier run learned (the results cache's `tier`),
 * never lowered (`tierFor`, T2.11). A pragma that names no tier is a warning, and the file keeps its
 * tier. A project that already runs every file as `process` reads no docblock.
 */
async function keysOf(
  member: Member,
  discovered: readonly DiscoveredFile[],
  warn: (warning: string) => void,
): Promise<Map<string, WorkerKey>> {
  const { isolation } = member.project
  const keys = new Map<string, WorkerKey>()
  const choices = await mapInBatches(discovered, BATCH, async (file) => {
    const docblock = isolation === 'process' ? undefined : await readIsolatePragma(file.path)
    const learned = member.cache?.get(member.cacheProject, file.relativePath)?.tier
    return tierFor(file.relativePath, {
      configured: isolation,
      ...(docblock === undefined ? {} : { docblock }),
      ...(learned === undefined ? {} : { learned }),
    })
  })
  for (const [index, file] of discovered.entries()) {
    const choice = choices[index]
    if (choice === undefined) continue
    for (const warning of choice.warnings) warn(warning)
    keys.set(file.relativePath, keyFor(member, choice.tier))
  }
  return keys
}

/**
 * Prunes the cache's history of files the project no longer has, and returns the files in the
 * order they should run. `everything` is the project's whole file set (discovery is unfiltered),
 * so the history of any other file is stale; `discovered` is what a run's file filters kept, and
 * is what runs. Pruning against the filtered set would drop the history of every file the filter
 * left out.
 */
function planQueue(
  member: Member,
  everything: readonly DiscoveredFile[],
  discovered: readonly DiscoveredFile[],
  runRoot: string,
  keys: ReadonlyMap<string, WorkerKey>,
): QueuedFile[] {
  const { project, cache, cacheProject } = member
  cache?.prune(cacheProject, new Set(everything.map((file) => file.relativePath)))
  const entries = new Map<string, QueuedFile>()
  const inputs: ScheduleInput[] = discovered.map((file) => {
    const runPath = relativePosix(runRoot, join(project.rootDir, file.relativePath))
    entries.set(file.relativePath, {
      member,
      file,
      key: keys.get(file.relativePath) ?? keyFor(member, project.isolation),
      timingsPath: runPath,
      info: {
        fileId: fileIdOf(member.identity, file.relativePath),
        path: file.relativePath,
        project: project.name,
        projectIndex: member.projectIndex,
        ...(runPath === file.relativePath ? {} : { runPath }),
      },
    })
    return scheduleInputOf(member, file, project.name)
  })
  const ordered = sequencerFor(project).sort(inputs)
  return ordered.flatMap((input) => entries.get(input.path) ?? [])
}

/**
 * A file the worker found leaking, failed whole: its tests are discarded (`resultsDiscarded`) and
 * its one error is Provino's own text, which a dialect with a wording of its own replaces where it
 * reads `FileResult.leaks` (the Jest dialect's result builder does).
 */
function leakedResult(reported: FileResult): FileResult {
  return {
    ...reported,
    state: 'fail',
    resultsDiscarded: true,
    leaks: true,
    errors: [
      {
        name: 'Error',
        message:
          'The file leaks memory: its environment was still reachable after its teardown (detectLeaks)',
      },
    ],
  }
}

/** How a file's pool outcome becomes its result; `end` is the `file-end` result its events carried, if any. */
function resultOf(
  file: FileInfo,
  outcome: PoolOutcome,
  end: TaskResult | undefined,
  elapsedMs: number,
  rules: FileRules,
): FileResult {
  const failed = (
    durationMs: number,
    errors: SerializedError[],
    workerExit?: WorkerExit,
  ): FileResult => ({
    file,
    state: 'fail',
    durationMs,
    ...(workerExit === undefined ? {} : { workerExit }),
    errors,
  })
  switch (outcome.type) {
    case 'aborted':
      // Only a file that had started gets here: the run ended while it was running.
      return failed(elapsedMs, [
        {
          name: 'Interrupted',
          message: `The run was interrupted while ${file.path} was running`,
        },
      ])
    case 'crashed':
      return failed(elapsedMs, [crashError(file, outcome.exit)], outcome.exit)
    case 'failed':
      return failed(elapsedMs, [serializeError(outcome.error)])
    case 'start-failed':
      return failed(0, [serializeError(outcome.error)], outcome.exit)
    case 'done': {
      if (end === undefined) {
        return failed(elapsedMs, [
          {
            name: 'Error',
            message: `The worker finished ${file.path} without reporting its result`,
          },
        ])
      }
      // A file the worker's runner failed after it ran (its environment's teardown threw) is
      // failed whole, as Jest's `runTest` rejecting is: the error is the file's, whatever it
      // declared and however its tests ended.
      const state = rules.runnerFailed ? 'fail' : stateOf(end.state, rules)
      // A file that ended with no error and collected no test declared none, which Jest fails
      // ("Your test suite must contain at least one test."): collected is what counts, so a file
      // whose tests are all skipped or todo is not this.
      const noTests =
        state !== 'fail' &&
        rules.failsWithNoTests &&
        rules.collected === 0 &&
        end.errors.length === 0
      return {
        file,
        state: noTests ? 'fail' : state,
        durationMs: end.durationMs,
        errors: noTests ? [NO_TESTS_ERROR] : end.errors,
        ...(outcome.done.snapshot === undefined ? {} : { snapshot: outcome.done.snapshot }),
        ...(end.childOrder === undefined ? {} : { childOrder: end.childOrder }),
        ...(outcome.done.heapUsedBytes === undefined
          ? {}
          : { heapUsedBytes: outcome.done.heapUsedBytes }),
      }
    }
    default:
      return outcome satisfies never
  }
}
