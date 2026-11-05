// The coordinator's run (U3, minimal): discover the project's files, order them, push them
// through the pool, and report to the bus. The CLI, `run()` and config loading are `provino`'s.
import { createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import { serializeError } from '@provino/rpc'
import type {
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
  TaskState,
  TransportFactory,
  WorkerExit,
} from '@provino/types'
import { createResultsCache, defaultCacheDir, type ResultsCache } from './cache.ts'
import { type DiscoveredFile, discoverFiles } from './discover.ts'
import { createFileDispatch, createIdleDispatch } from './dispatch.ts'
import { OrchestratorError } from './errors.ts'
import { fileIdOf } from './file-id.ts'
import { workerKeyOf } from './key.ts'
import { createPool, defaultMaxWorkers, type PoolOutcome, workerExitOf } from './pool.ts'
import { createHistorySequencer } from './sequencer.ts'
import { forksTransport } from './transport/forks.ts'
import { inlineTransport } from './transport/inline.ts'
import { describeExit } from './transport/shared.ts'
import { threadsTransport } from './transport/threads.ts'

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
   * Default `defaultMaxWorkers()`. An `inline` pool ignores it and runs exactly one worker
   * (`--runInBand`): the expect slot is process-global, so a second inline worker in this
   * process cannot boot. Two inline runs overlapping in one process share that slot and are not
   * supported; use forks or threads.
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
 * the config different (root, include, exclude), so two configs without a name in one root don't
 * prune each other's history.
 * @public
 */
export function projectCacheKey(project: ResolvedProject): string {
  const identity = JSON.stringify([
    project.rootDir,
    [...project.include].sort(),
    [...project.exclude].sort(),
  ])
  return `${project.name}#${createHash('sha1').update(identity).digest('hex').slice(0, 8)}`
}

/** `new RegExp` with the policy's flags, once; the workers get the string. */
function checkPattern(pattern: string | undefined, flags: string): void {
  if (pattern === undefined) return
  try {
    new RegExp(pattern, flags)
  } catch (error) {
    throw new OrchestratorError(
      'ORCH_BAD_PATTERN',
      `The test name pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

/** A discovered file with the identity the bus knows it by. */
interface QueuedFile {
  readonly info: FileInfo
  readonly file: DiscoveredFile
}

interface TransportSettings {
  readonly entry: string | URL
  readonly stdout: NodeJS.WritableStream | undefined
  readonly stderr: NodeJS.WritableStream | undefined
  readonly startTimeoutMs: number
  readonly teardownTimeoutMs: number
  readonly execArgv: readonly string[] | undefined
}

function transportFor(kind: PoolKind, settings: TransportSettings): TransportFactory {
  const base = {
    entry: settings.entry,
    startTimeoutMs: settings.startTimeoutMs,
    teardownTimeoutMs: settings.teardownTimeoutMs,
    ...(settings.stdout === undefined ? {} : { stdout: settings.stdout }),
    ...(settings.stderr === undefined ? {} : { stderr: settings.stderr }),
  }
  const withFlags = {
    ...base,
    ...(settings.execArgv === undefined ? {} : { execArgv: settings.execArgv }),
  }
  switch (kind) {
    case 'forks':
      return forksTransport(withFlags)
    case 'threads':
      return threadsTransport(withFlags)
    case 'inline':
      return inlineTransport(base)
    default:
      return kind satisfies never
  }
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
 * Runs a project's test files and reports to the bus.
 *
 * Everything that can fail on a bad option comes first, before the bus hears of the run: the
 * pattern, the worker entry, the pool (recycling by memory or file count is not built, so setting
 * it rejects with `ORCH_NOT_IMPLEMENTED`). Then discovery, the results cache, the order
 * (`createHistorySequencer`), `run:start` and a `file:queued` per file in that order, the files
 * through the pool, the pool is closed (every worker has exited), the cache is written, and
 * `run:end`. A run that finds no files emits `run:start` and `run:end` and nothing between.
 *
 * Per file the bus sees `file:start(file, workerId)` when a worker takes it, the file's own events
 * as the worker sends them, and `file:end` after the last of them: **every `file:start` is
 * followed by exactly one `file:end`, and a `file:end` never comes without its `file:start`.** A
 * file's result is its `file-end` (`todo` and `queued` count as `skip`, `running` as `fail`); a
 * worker that dies running it fails it with a `WorkerCrash` error and `workerExit`. A worker that
 * cannot start fails the file it was starting for, and after three such failures in a row every
 * file left once no worker is alive or starting; those files get `file:start` (with the worker
 * whose failed start their error is) just before their `file:end`. A file whose worker ended it
 * without a `file-end` fails too. When the run is aborted, a file that had started is cut off: it
 * gets a `file:end` (`fail`, one error naming the interruption) and is in the summary; a file
 * that had not started gets neither event and is not in the summary.
 *
 * The summary lists the files in the order they were queued. `unhandled` holds every unhandled
 * error of the run. `reason` is `interrupted` when the run was aborted, else `failed` when a file
 * failed or, if the policy says `fail-run`, an error went unhandled.
 *
 * Rejects with `ORCH_BAD_PATTERN` or `ORCH_NOT_IMPLEMENTED` before anything is emitted. If
 * something throws after `run:start`, the pool is closed, the bus gets `error(…, 'coordinator')`
 * and a `run:end` with `reason: 'failed'` (the files that finished so far), and then the error
 * propagates. Coverage and `deps` events are not used yet.
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
    // One inline worker at most: the expect slot is process-global (see `RunPoolOptions`).
    maxWorkers: kind === 'inline' ? 1 : (options.pool?.maxWorkers ?? defaultMaxWorkers()),
    recycle: options.pool?.recycle ?? {},
    teardownTimeoutMs: options.pool?.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS,
    startTimeoutMs: options.pool?.startTimeoutMs ?? START_TIMEOUT_MS,
  }
  const workerEntry = options.entry ?? import.meta.resolve('@provino/orchestrator/worker/main')

  const unhandled: SerializedError[] = []
  const lastFile = new Map<number, FileInfo>()
  // Nothing starts until a file is run, but this is where a bad option throws (`recycle`, the
  // transport's own entry), so it comes before `run:start`.
  const pool = createPool(poolOptions, {
    transport: (poolKind) =>
      transportFor(poolKind, {
        entry: workerEntry,
        stdout: options.stdout,
        stderr: options.stderr,
        startTimeoutMs: poolOptions.startTimeoutMs,
        teardownTimeoutMs: poolOptions.teardownTimeoutMs,
        execArgv,
      }),
    init: (workerKey, workerId) => ({
      key: workerKey,
      workerId,
      isolation: project.isolation,
      provided: {},
      config: project.config,
    }),
    methods: {
      resolveSnapshotPath: (file) => file,
      writeSnapshot: () => {},
      readTimings: (file) => {
        const path = (isAbsolute(file) ? relative(project.rootDir, file) : file)
          .split(sep)
          .join('/')
        return cache?.get(cacheProject, path)?.durationMs
      },
    },
    onIdleEvents: createIdleDispatch({
      bus,
      fileOf: (workerId) => lastFile.get(workerId),
      onUnhandled: (error) => void unhandled.push(error),
    }),
    // Late output that couldn't be handed to the bus is an error of the run, not of a file.
    onError: (error) => {
      // A worker that ended badly with no file to blame is a failure of the run, not of a file.
      if (error instanceof OrchestratorError && error.code === 'ORCH_WORKER_EXITED') {
        unhandled.push(serializeError(error))
      }
      void bus.emit('error', serializeError(error), 'coordinator')
    },
    ...(signal === undefined ? {} : { signal }),
  })

  /** The result of each file that has one, by path. */
  const results = new Map<string, FileResult>()
  let queue: readonly QueuedFile[] = []
  let interrupted = false
  let announced = false

  /** The files that have a result, in queue order. */
  const finishedFiles = (): FileResult[] =>
    queue.flatMap((entry) => results.get(entry.info.path) ?? [])

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
      updateSnapshots: 'none',
      ...(options.testNamePattern === undefined
        ? {}
        : { testNamePattern: options.testNamePattern }),
    }
    let taken = performance.now()
    let started = false
    const outcome = await pool.run({
      key,
      job,
      onStart: async (workerId) => {
        taken = performance.now()
        started = true
        lastFile.set(workerId, entry.info)
        await bus.emit('file:start', entry.info, workerId)
      },
      onEvents: dispatch.handle,
    })
    if (outcome.type === 'aborted') {
      interrupted = true
      // A file that never started was never announced as started: nothing to end.
      if (!started) return
    }
    if (outcome.type === 'start-failed') {
      // No worker took the file, but a `file:end` always has a `file:start` before it: this one
      // names the worker whose failed start the file's error is.
      await bus.emit('file:start', entry.info, outcome.workerId)
    }
    const result = resultOf(entry.info, outcome, dispatch, performance.now() - taken)
    // A start failure or an interruption says nothing about the file; a skipped file isn't
    // remembered (as Jest's).
    if (outcome.type !== 'start-failed' && outcome.type !== 'aborted' && result.state !== 'skip') {
      cache?.record(cacheProject, entry.info.path, {
        durationMs: result.durationMs,
        failed: result.state === 'fail',
        tests: dispatch.tests,
        at: Date.now(),
      })
    }
    results.set(entry.info.path, result)
    await bus.emit('file:end', result)
  }

  try {
    const discovered = await discoverFiles({
      rootDir: project.rootDir,
      include: project.include,
      exclude: project.exclude,
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
      const summary: RunSummary = {
        reason: signal?.aborted === true ? 'interrupted' : 'passed',
        files: [],
        unhandled: [],
        durationMs: performance.now() - startedAt,
      }
      await bus.emit('run:end', summary)
      return summary
    }

    // Discovery is unfiltered, so what it found is the project's whole file set, and the history
    // of any other file is stale. A run that filters its files (T11.13, U2) sees only some of
    // them and must not prune.
    cache?.prune(cacheProject, new Set(discovered.map((file) => file.relativePath)))
    const inputs: ScheduleInput[] = discovered.map((file) => {
      const history = cache?.get(cacheProject, file.relativePath)
      return {
        path: file.relativePath,
        project: project.name,
        sizeBytes: file.sizeBytes,
        ...(history === undefined ? {} : { history }),
      }
    })
    const ordered = createHistorySequencer({
      unknownFirst: orchestrator.sequence.unknownFirst,
    }).sort(inputs)
    const byPath = new Map(discovered.map((file) => [file.relativePath, file]))
    queue = ordered.flatMap((input) => {
      const file = byPath.get(input.path)
      return file === undefined
        ? []
        : [
            {
              file,
              info: {
                fileId: fileIdOf(project.name, file.relativePath),
                path: file.relativePath,
                project: project.name,
              },
            },
          ]
    })

    announced = true
    await bus.emit(
      'run:start',
      info,
      queue.map((entry) => entry.info),
    )
    for (const entry of queue) await bus.emit('file:queued', entry.info)

    await Promise.all(queue.map((entry) => runFile(entry)))
    await pool.close()
    try {
      await cache?.write()
    } catch (error) {
      // The history is a convenience: a read-only directory must not fail a run that passed.
      stderr.write(
        `Provino: could not write the results cache: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }

    const files = finishedFiles()
    const failed =
      files.some((file) => file.state === 'fail') ||
      (orchestrator.unhandledErrors === 'fail-run' && unhandled.length > 0)
    const summary: RunSummary = {
      reason: interrupted ? 'interrupted' : failed ? 'failed' : 'passed',
      files,
      unhandled,
      durationMs: performance.now() - startedAt,
    }
    await bus.emit('run:end', summary)
    return summary
  } catch (error) {
    await pool.close()
    // Reporters that heard `run:start` hear how it ended, whatever threw.
    if (announced) {
      try {
        await bus.emit('error', serializeError(error), 'coordinator')
        await bus.emit('run:end', {
          reason: 'failed',
          files: finishedFiles(),
          unhandled,
          durationMs: performance.now() - startedAt,
        })
      } catch (reportFailure) {
        stderr.write(
          `Provino: could not report the failure to the reporters: ${reportFailure instanceof Error ? reportFailure.message : String(reportFailure)}\n`,
        )
      }
    }
    throw error
  }
}

/** How a file's pool outcome becomes its result. */
function resultOf(
  file: FileInfo,
  outcome: PoolOutcome,
  dispatch: ReturnType<typeof createFileDispatch>,
  elapsedMs: number,
): FileResult {
  switch (outcome.type) {
    case 'aborted':
      // Only a file that had started gets here: the run ended while it was running.
      return {
        file,
        state: 'fail',
        durationMs: elapsedMs,
        errors: [
          {
            name: 'Interrupted',
            message: `The run was interrupted while ${file.path} was running`,
          },
        ],
      }
    case 'crashed':
      return {
        file,
        state: 'fail',
        durationMs: elapsedMs,
        workerExit: outcome.exit,
        errors: [crashError(file, outcome.exit)],
      }
    case 'failed':
      return {
        file,
        state: 'fail',
        durationMs: elapsedMs,
        errors: [serializeError(outcome.error)],
      }
    case 'start-failed': {
      const exit = workerExitOf(outcome.error)
      return {
        file,
        state: 'fail',
        durationMs: 0,
        ...(exit === undefined ? {} : { workerExit: exit }),
        errors: [serializeError(outcome.error)],
      }
    }
    case 'done': {
      const end = dispatch.result
      if (end === undefined) {
        return {
          file,
          state: 'fail',
          durationMs: elapsedMs,
          errors: [
            {
              name: 'Error',
              message: `The worker finished ${file.path} without reporting its result`,
            },
          ],
        }
      }
      return {
        file,
        state: stateOf(end.state),
        durationMs: end.durationMs,
        errors: end.errors,
      }
    }
    default:
      return outcome satisfies never
  }
}
