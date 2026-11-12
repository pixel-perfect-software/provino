// The coordinator's run (U3, minimal): discover the project's files, order them, push them
// through the pool, and report to the bus. The CLI, `run()` and config loading are `provino`'s.
import { resolve } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import { serializeError } from '@provino/rpc'
import {
  createSnapshotAggregate,
  resolveUpdateMode,
  snapshotRunFails,
} from '@provino/snapshot/node'
import type {
  FileFilter,
  FileInfo,
  FileJob,
  FileResult,
  PoolKind,
  PoolOptions,
  RecyclePolicy,
  ReporterBus,
  RunInfo,
  RunSummary,
  ScheduleInput,
  SerializedError,
  TaskResult,
  TaskState,
  WorkerEvent,
  WorkerExit,
} from '@provino/types'
import { createResultsCache, defaultCacheDir, type ResultsCache } from './cache.ts'
import { type DiscoveredFile, discoverFiles } from './discover.ts'
import { discoverByRules } from './discover-rules.ts'
import { createFileDispatch, createIdleDispatch } from './dispatch.ts'
import { OrchestratorError } from './errors.ts'
import { fileIdOf, relativePosix } from './file-id.ts'
import { hashOf, workerKeyOf } from './key.ts'
import { createPool, defaultMaxWorkers, type PoolOutcome } from './pool.ts'
import { selectFiles } from './select.ts'
import { createHistorySequencer } from './sequencer.ts'
import { type TransportForOptions, transportFor } from './transport/for-kind.ts'
import { describeExit } from './transport/shared.ts'
import { messageOf } from './util.ts'

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
  readonly recycle?: RecyclePolicy
  readonly startTimeoutMs?: number
  readonly teardownTimeoutMs?: number
  /** Node flags for the workers (forks and threads). Default: this process's, for the pool key. */
  readonly execArgv?: readonly string[]
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
   * run ends with `reason: 'interrupted'`.
   */
  readonly signal?: AbortSignal
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
  readonly info: FileInfo
  readonly file: DiscoveredFile
}

/** A file's state for reporters: `todo` and `queued` ran nothing (`skip`), `running` never finished (`fail`). */
function stateOf(state: TaskState): FileResult['state'] {
  switch (state) {
    case 'pass':
    case 'fail':
    case 'skip':
      return state
    case 'todo':
    case 'queued':
      return 'skip'
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

/**
 * Runs a project's test files and reports to the bus, and resolves with the summary.
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
export async function runProject(
  project: ResolvedProject,
  options: RunProjectOptions,
): Promise<RunSummary> {
  const { bus, signal } = options
  const { orchestrator, core } = project.policy
  const cacheProject = projectCacheKey(project)
  checkPattern(options.testNamePattern, core.testNamePatternFlags)
  // What every file does with its snapshots (build-plan §6: the worker writes the `.snap` files).
  const updateSnapshots = resolveUpdateMode({
    update: options.update ?? false,
    ci: project.config.ci,
    env: options.env ?? process.env,
    policy: project.policy.snapshot,
  })
  const snapshots = createSnapshotAggregate()

  const startedAt = performance.now()
  const stderr = options.stderr ?? process.stderr
  const cache =
    options.cache === false
      ? undefined
      : (options.cache ?? createResultsCache(defaultCacheDir(project.rootDir)))
  const kind = options.pool?.kind ?? orchestrator.pool.default
  const execArgv = options.pool?.execArgv
  const key = workerKeyOf({
    project: project.name,
    pool: kind,
    environment: project.environment,
    environmentOptions: project.config.environment.options,
    execArgv: execArgv ?? process.execArgv,
  })
  const poolOptions: PoolOptions = {
    kind,
    maxWorkers: options.pool?.maxWorkers ?? defaultMaxWorkers(),
    recycle: options.pool?.recycle ?? {},
    teardownTimeoutMs: options.pool?.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS,
    startTimeoutMs: options.pool?.startTimeoutMs ?? START_TIMEOUT_MS,
  }
  const transportOptions: TransportForOptions = {
    entry: options.entry ?? import.meta.resolve('@provino/orchestrator/worker/main'),
    startTimeoutMs: poolOptions.startTimeoutMs,
    teardownTimeoutMs: poolOptions.teardownTimeoutMs,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    ...(execArgv === undefined ? {} : { execArgv }),
  }

  const unhandled: SerializedError[] = []
  /** Per worker, the file it ran last and when that file's `file:end` has been emitted. */
  const lastFile = new Map<number, { readonly info: FileInfo; readonly ended: Promise<void> }>()
  // Nothing starts until a file is run, but this is where a bad option throws (`recycle`, the
  // transport's own entry), so it comes before `run:start`.
  const pool = createPool(poolOptions, {
    transport: (poolKind) => transportFor(poolKind, transportOptions),
    init: (workerKey, workerId) => ({
      key: workerKey,
      workerId,
      isolation: project.isolation,
      provided: {},
      config: project.config,
    }),
    methods: {
      readTimings: (file) =>
        cache?.get(cacheProject, relativePosix(project.rootDir, resolve(project.rootDir, file)))
          ?.durationMs,
    },
    onIdleEvents: idleEvents(),
    onError: (error, errorKind) => {
      // Late output that couldn't be handed to the bus, or a worker that ended badly with no file
      // to blame: errors of the run, not of a file (a lost worker also fails the run).
      if (errorKind === 'worker-lost') unhandled.push(serializeError(error))
      void bus.emit('error', serializeError(error), 'coordinator')
    },
    ...(signal === undefined ? {} : { signal }),
  })

  /** What a worker sends while it stops reaches the bus under its last file, after that file's `file:end`. */
  function idleEvents(): (workerId: number, events: readonly WorkerEvent[]) => Promise<void> {
    const dispatch = createIdleDispatch({
      bus,
      fileOf: (workerId) => lastFile.get(workerId)?.info,
      onUnhandled: (error) => void unhandled.push(error),
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

  /** The result of each file that has one, by path. */
  const results = new Map<string, FileResult>()
  let queue: readonly QueuedFile[] = []
  let interrupted = false
  let announced = false

  /** The files that have a result, in queue order. */
  const finishedFiles = (): FileResult[] =>
    queue.flatMap((entry) => results.get(entry.info.path) ?? [])

  const summarize = (reason: RunSummary['reason']): RunSummary => {
    const run = snapshots.summary(updateSnapshots)
    return {
      reason,
      files: finishedFiles(),
      unhandled,
      durationMs: performance.now() - startedAt,
      ...(run === undefined ? {} : { snapshots: run }),
    }
  }

  /** One file, from its turn in the queue to its `file:end`. */
  async function runFile(entry: QueuedFile): Promise<void> {
    const dispatch = createFileDispatch({
      bus,
      file: entry.info,
      onUnhandled: (error) => void unhandled.push(error),
    })
    const job: FileJob = {
      file: entry.file.path,
      fileId: entry.info.fileId,
      updateSnapshots,
      ...(options.testNamePattern === undefined
        ? {}
        : { testNamePattern: options.testNamePattern }),
    }
    let takenAt: number | undefined
    const ended = Promise.withResolvers<void>()
    try {
      const outcome = await pool.run({
        key,
        job,
        onStart: async (workerId) => {
          takenAt = performance.now()
          lastFile.set(workerId, { info: entry.info, ended: ended.promise })
          await bus.emit('file:start', entry.info, workerId)
        },
        onEvents: dispatch.handle,
      })
      if (outcome.type === 'aborted') {
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
        snapshots.add(outcome.done.snapshot, entry.file.path)
      }
      const elapsedMs = takenAt === undefined ? 0 : performance.now() - takenAt
      const result = resultOf(entry.info, outcome, dispatch.result, elapsedMs)
      // A start failure or an interruption says nothing about the file; a skipped file isn't
      // remembered (as Jest's).
      if (
        outcome.type !== 'start-failed' &&
        outcome.type !== 'aborted' &&
        result.state !== 'skip'
      ) {
        cache?.record(cacheProject, entry.info.path, {
          durationMs: result.durationMs,
          failed: result.state === 'fail',
          tests: dispatch.tests,
          at: Date.now(),
        })
      }
      results.set(entry.info.path, result)
      await bus.emit('file:end', result)
    } finally {
      ended.resolve()
    }
  }

  /** Writes the history; it is a convenience, so a failure is a line on `stderr`, never a rejection. */
  async function writeCache(): Promise<void> {
    try {
      await cache?.write()
    } catch (error) {
      // A read-only directory must not fail a run that passed.
      stderr.write(`Provino: could not write the results cache: ${messageOf(error)}\n`)
    }
  }

  try {
    const everything = await discoverProject(project)
    const discovered = selectFiles(everything, options.fileFilters ?? [], {
      rootDir: project.rootDir,
      cwd: resolve(options.cwd ?? process.cwd()),
    })
    const info: RunInfo = {
      root: project.rootDir,
      projects: [project.name],
      startTime: startedAt,
      watch: false,
    }
    if (discovered.length === 0) {
      announced = true
      await bus.emit('run:start', info, [])
      await pool.close()
      const summary = summarize(signal?.aborted === true ? 'interrupted' : 'passed')
      await bus.emit('run:end', summary)
      return summary
    }

    queue = planQueue(
      project,
      everything,
      discovered,
      cache,
      cacheProject,
      orchestrator.sequence.unknownFirst,
    )

    announced = true
    await bus.emit(
      'run:start',
      info,
      queue.map((entry) => entry.info),
    )
    for (const entry of queue) await bus.emit('file:queued', entry.info)

    // `runFile` asks the pool for its worker before its first `await`, so every file is requested
    // by the time `drain` runs: from here on an idle worker has nothing to wait for.
    const running = queue.map((entry) => runFile(entry))
    pool.drain()
    await Promise.all(running)
    // The history is complete; writing it overlaps the workers' shutdown.
    await Promise.all([pool.close(), writeCache()])

    const failed =
      finishedFiles().some((file) => file.state === 'fail') ||
      snapshotRunFails(snapshots.summary(updateSnapshots), project.policy.snapshot) ||
      (orchestrator.unhandledErrors === 'fail-run' && unhandled.length > 0)
    const summary = summarize(interrupted ? 'interrupted' : failed ? 'failed' : 'passed')
    await bus.emit('run:end', summary)
    return summary
  } catch (error) {
    await pool.close()
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
  }
}

/**
 * Prunes the cache's history of files the project no longer has, and returns the files in the
 * order they should run. `everything` is the project's whole file set (discovery is unfiltered),
 * so the history of any other file is stale; `discovered` is what a run's file filters kept, and
 * is what runs. Pruning against the filtered set would drop the history of every file the filter
 * left out.
 */
function planQueue(
  project: ResolvedProject,
  everything: readonly DiscoveredFile[],
  discovered: readonly DiscoveredFile[],
  cache: ResultsCache | undefined,
  cacheProject: string,
  unknownFirst: boolean,
): QueuedFile[] {
  cache?.prune(cacheProject, new Set(everything.map((file) => file.relativePath)))
  const entries = new Map<string, QueuedFile>()
  const inputs: ScheduleInput[] = discovered.map((file) => {
    entries.set(file.relativePath, {
      file,
      info: {
        fileId: fileIdOf(project.name, file.relativePath),
        path: file.relativePath,
        project: project.name,
      },
    })
    const history = cache?.get(cacheProject, file.relativePath)
    return {
      path: file.relativePath,
      project: project.name,
      sizeBytes: file.sizeBytes,
      ...(history === undefined ? {} : { history }),
    }
  })
  const ordered = createHistorySequencer({ unknownFirst }).sort(inputs)
  return ordered.flatMap((input) => entries.get(input.path) ?? [])
}

/** How a file's pool outcome becomes its result; `end` is the `file-end` result its events carried, if any. */
function resultOf(
  file: FileInfo,
  outcome: PoolOutcome,
  end: TaskResult | undefined,
  elapsedMs: number,
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
        : { file, state: stateOf(end.state), durationMs: end.durationMs, errors: end.errors }
    default:
      return outcome satisfies never
  }
}
