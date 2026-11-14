// The coordinator's run (U3, minimal): discover the project's files, order them, push them
// through the pool, and report to the bus. The CLI, `run()` and config loading are `provino`'s.
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { pruneTransformCache, type ResolvedProject, withTransformCache } from '@provino/config'
import { readIsolatePragma, tierFor } from '@provino/loader'
import { serializeError } from '@provino/rpc'
import { resolveUpdateMode } from '@provino/snapshot/node'
import type {
  CoverageSummary,
  FileFilter,
  FileInfo,
  FileJob,
  FileResult,
  IsolationTier,
  OpenHandle,
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
  WorkerEvent,
  WorkerExit,
  WorkerKey,
} from '@provino/types'
import { cacheDirectories, createResultsCache, type ResultsCache } from './cache.ts'
import { finishCoverage, type RunCoverageHooks } from './coverage.ts'
import { createRawCoverageStore } from './coverage-store.ts'
import { createDepsTable, type DepsTable } from './deps-table.ts'
import { type DiscoveredFile, discoverFiles } from './discover.ts'
import { discoverByRules } from './discover-rules.ts'
import { createFileDispatch, createIdleDispatch } from './dispatch.ts'
import { OrchestratorError } from './errors.ts'
import { isRunSignal, RUN_SIGNALS } from './exit-code.ts'
import { fileIdOf, relativePosix } from './file-id.ts'
import { type GlobalSetupRun, type RunGlobalHooks, runGlobalSetup } from './global-setup.ts'
import { configHash, hashOf, type WorkerKeyInput, workerKeyOf } from './key.ts'
import { collectOpenHandles, type OpenHandleTracker } from './open-handles.ts'
import { createPool, defaultMaxWorkers, type PoolOutcome } from './pool.ts'
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

/** Track 9: how long a worker may take to say `ready`, and to stop before it is killed. */
const START_TIMEOUT_MS = 30_000
const TEARDOWN_TIMEOUT_MS = 10_000

/**
 * The pool's settings a run can override; the rest come from the project's policy.
 * @public
 */
export interface RunPoolOptions {
  /** Default `policy.orchestrator.pool.default`. */
  readonly kind?: PoolKind
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
  /** Where the policy's snapshot update variable is read (Vitest's `UPDATE_SNAPSHOT`). Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Run only the files these filters keep (`selectFiles`). A filtered run still discovers every
   * file, so the results cache is pruned against the whole set and keeps the history of the
   * files it did not run.
   */
  readonly fileFilters?: readonly FileFilter[]
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
 * A file's state for reporters, decided here once (the reporters, the results cache and
 * `normalized-json` all read it): `todo` and `queued` ran nothing (`skip`), `running` never
 * finished (`fail`), and a `skip` file with a test that ended `todo` is the policy's
 * `todoOnlyFile` (Jest passes it, DV50).
 */
function stateOf(
  state: TaskState,
  todo: { readonly ended: number; readonly todoOnlyFile: 'pass' | 'skip' },
): FileResult['state'] {
  switch (state) {
    case 'pass':
    case 'fail':
      return state
    case 'skip':
    case 'todo':
    case 'queued':
      return todo.ended > 0 ? todo.todoOnlyFile : 'skip'
    case 'running':
      return 'fail'
    default:
      return state satisfies never
  }
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
  /** What the project's files reported, its update mode and its policy. */
  readonly snapshots: SnapshotMember
  readonly cache: ResultsCache | undefined
  /** What the project's workers are keyed by, before the isolation tier of a file is added. */
  readonly keyInput: Omit<WorkerKeyInput, 'isolation'>
  /** The worker key of each tier a file of this project runs at. */
  readonly keys: Map<IsolationTier, WorkerKey>
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
export async function runProjects(
  projects: readonly ResolvedProject[],
  options: RunProjectOptions,
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
  // Open handles are found with `async_hooks` in this process, so the files run in it.
  const kind: PoolKind =
    options.detectOpenHandles === true
      ? 'inline'
      : (options.pool?.kind ?? orchestrator.pool.default)
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

  // Coverage is the projects' own (their worker config says which files count); the run keeps
  // what the workers send.
  const coverageStore = projects.some((project) => project.config.coverage !== undefined)
    ? createRawCoverageStore()
    : undefined

  const caches = new Map<string, ResultsCache>()
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
  const runSeed = Math.floor(0x1_0000_0000 * Math.random()) - 0x8000_0000
  /** Each lockfile's hash by path, so projects that share a lockfile read it once. */
  const lockfileHashes = new Map<string, string>()
  // Two projects can share a name, yet differ in discovery, environment, transform or setup files;
  // each still needs a worker key, a file-id namespace and a results history of its own.
  const takenIdentities = new Set<string>()
  const nameCounts = Map.groupBy(projects, (project) => project.name)
  const cacheKeyCounts = Map.groupBy(projects, projectCacheKey)
  const members: Member[] = projects.map((resolved, index) => {
    // The transform cache (T3.6) is on unless the run has no cache (`--no-cache`): the directory is
    // wiped here if the lockfile changed, and handed to the project's workers.
    const cached =
      options.cache === false
        ? resolved
        : withTransformCache(resolved, cacheDirectories(resolved).transform, lockfileHashes)
    const project: SeededProject = {
      ...cached,
      config: { ...cached.config, seed: cached.config.seed ?? runSeed },
    }
    const base =
      nameCounts.get(project.name)?.length === 1
        ? project.name
        : `${project.name}#${configHash(project.config).slice(0, 8)}`
    const identity = takenIdentities.has(base) ? `${base}@${index}` : base
    takenIdentities.add(identity)
    const cacheKey = projectCacheKey(project)
    return {
      project,
      // The results history keeps its stable key, so editing a config doesn't lose it, unless
      // another project of the run has the same one.
      cacheProject: cacheKeyCounts.get(cacheKey)?.length === 1 ? cacheKey : identity,
      identity,
      projectIndex: index,
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
      cache: cacheFor(project),
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

  const startedAt = performance.now()
  const stderr = options.stderr ?? process.stderr
  const startTimeoutMs = options.pool?.startTimeoutMs ?? START_TIMEOUT_MS
  const teardownTimeoutMs = options.pool?.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS
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
  const poolOptions: PoolOptions = {
    kind,
    maxWorkers,
    recycle,
    teardownTimeoutMs,
    startTimeoutMs,
    ...(fileTimeoutMs === undefined ? {} : { fileTimeoutMs }),
  }

  const unhandled: SerializedError[] = []
  /** Global setup, once it has run (T9.15): its teardown comes after the run, whatever ends it. */
  let globalSetup: GlobalSetupRun | undefined
  /** The run ended in an error, so a failing teardown must not replace it. */
  let thrown = false
  /** Per worker, the file it ran last and when that file's `file:end` has been emitted. */
  const lastFile = new Map<number, { readonly info: FileInfo; readonly ended: Promise<void> }>()
  /** Per worker, the module paths its `deps` events have named: the ids are the worker's for its life. */
  const depsTables = new Map<number, DepsTable>()
  // Nothing starts until a file is run, but this is where a bad option throws (`recycle`, the
  // transport's own entry), so it comes before `run:start`.
  const pool = createPool(poolOptions, {
    transport: () => factory,
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
  })

  /** What a worker sends while it stops reaches the bus under its last file, after that file's `file:end`. */
  function idleEvents(): (workerId: number, events: readonly WorkerEvent[]) => Promise<void> {
    const dispatch = createIdleDispatch({
      bus,
      fileOf: (workerId) => lastFile.get(workerId)?.info,
      onUnhandled: (error) => void unhandled.push(error),
      ...(coverageStore === undefined
        ? {}
        : { onCoverage: (workerId, event) => coverageStore.add(workerId, event) }),
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

  /** The result of each queued file that has one. */
  const results = new Map<QueuedFile, FileResult>()
  /** The time of each file that ran to its end, by the path the timings file knows it by (`--update-timings`). */
  const measured = new Map<string, number>()
  let queue: readonly QueuedFile[] = []
  let interrupted = false
  let announced = false
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
        : { onCoverage: (event) => coverageStore.add(takenBy, event) }),
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
      ...(options.testNamePattern === undefined
        ? {}
        : { testNamePattern: options.testNamePattern }),
    }
    let takenAt: number | undefined
    const ended = Promise.withResolvers<void>()
    try {
      const outcome = await pool.run({
        key: entry.key,
        job,
        onStart: async (workerId) => {
          takenBy = workerId
          takenAt = performance.now()
          lastFile.set(workerId, { info: entry.info, ended: ended.promise })
          await bus.emit('file:start', entry.info, workerId)
        },
        onEvents: dispatch.handle,
        // Jest's rule counts a file's failed tests when the file ends: before its worker takes
        // another file, or `--bail` would start one it is about to give up.
        onDone: () => {
          if (bailAfter === 'file') countFailed(failedInFile)
        },
      })
      if (outcome.type === 'aborted') {
        // The run's own bail cut this file short: Jest reports no result for a file it kills, so
        // neither do we (the one exception to `file:start` having a `file:end`). A signal that
        // came too is the stronger reason.
        if (bailed && signal?.aborted !== true) return
        interrupted = true
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
      const result = resultOf(entry.info, outcome, dispatch.result, elapsedMs, {
        ended: dispatch.todo,
        todoOnlyFile: member.project.policy.orchestrator.todoOnlyFile,
      })
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
      await Promise.all([...written].map((cache) => cache.write()))
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
    const everyFile = await Promise.all(
      members.map(async (member) => {
        const everything = await discoverProject(member.project)
        const discovered = selectFiles(everything, options.fileFilters ?? [], {
          rootDir: member.project.rootDir,
          cwd,
        })
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
    const found = everyFile.map((entry, index) => ({
      ...entry,
      discovered: shards?.[index] ?? entry.discovered,
    }))
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
      watch: false,
    }
    if (found.every((entry) => entry.discovered.length === 0)) {
      announced = true
      await bus.emit('run:start', info, [])
      await pool.close()
      const summary = summarize(signal?.aborted === true ? cutShort() : 'passed')
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
    const running = queue.map((entry) => runFile(entry))
    pool.drain()
    await Promise.all(running)
    // The history is complete; writing it overlaps the workers' shutdown.
    await Promise.all([pool.close(), writeCache()])
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
        : await finishCoverage(
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
    // The hook that tracks resources is process-wide: it must not outlive the run.
    handles?.dispose()
    // Reporters that heard `run:start` hear how it ended, whatever threw.
    if (announced) {
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

/** How a file's pool outcome becomes its result; `end` is the `file-end` result its events carried, if any. */
function resultOf(
  file: FileInfo,
  outcome: PoolOutcome,
  end: TaskResult | undefined,
  elapsedMs: number,
  todo: { readonly ended: number; readonly todoOnlyFile: 'pass' | 'skip' },
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
    case 'done':
      return end === undefined
        ? failed(elapsedMs, [
            {
              name: 'Error',
              message: `The worker finished ${file.path} without reporting its result`,
            },
          ])
        : {
            file,
            state: stateOf(end.state, todo),
            durationMs: end.durationMs,
            errors: end.errors,
            ...(outcome.done.snapshot === undefined ? {} : { snapshot: outcome.done.snapshot }),
          }
    default:
      return outcome satisfies never
  }
}
