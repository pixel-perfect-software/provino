// The coordinator's run (U3, minimal): discover the project's files, order them, push them
// through the pool, and report to the bus. The CLI, `run()` and config loading are `provino`'s.
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
  /** Default `defaultMaxWorkers()`. */
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
   * history.
   */
  readonly cache?: ResultsCache | false
  /** Run only tests whose full name matches (`-t`). Validated once, here, before anything starts. */
  readonly testNamePattern?: string
  /** Where the workers' own stderr goes (a crash's last words). Default: this process's. */
  readonly stderr?: NodeJS.WritableStream
  /** The worker entry, a `file:` URL or an absolute path. Default: `@provino/orchestrator/worker/main`. */
  readonly entry?: string | URL
  /**
   * Aborting stops the run: no file starts, the workers running files are killed, and the files
   * that did not finish are not reported (no `file:end`, not in the summary). The run ends with
   * `reason: 'interrupted'`.
   */
  readonly signal?: AbortSignal
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

interface TransportSettings {
  readonly entry: string | URL
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
 * Discovery, then the results cache, then the order (`createHistorySequencer`), then `run:start`
 * and a `file:queued` per file in that order, then the files through a pool, then the pool is
 * closed (every worker has exited), then the cache is written, then `run:end`. A run that finds no
 * files emits `run:start` and `run:end` and nothing between.
 *
 * Per file the bus sees `file:start(file, workerId)` when a worker takes it, the file's own events
 * as the worker sends them, and `file:end` after the last of them. A file's result is its
 * `file-end` (`todo` and `queued` count as `skip`, `running` as `fail`); a worker that dies
 * running it fails it with a `WorkerCrash` error and `workerExit`; a worker that cannot start
 * fails the file it was starting for, and after three such failures in a row every file left.
 * Files that fail to produce a result a worker's event stream can't explain (a worker that ended
 * the file without a `file-end`) fail too.
 *
 * The summary lists the files in the order they were queued. `unhandled` holds every unhandled
 * error of the run. `reason` is `failed` when a file failed or, if the policy says `fail-run`,
 * an error went unhandled.
 *
 * Rejects with `ORCH_BAD_PATTERN` before anything starts when `testNamePattern` isn't a regular
 * expression. Coverage and `deps` events are not used yet.
 * @public
 */
export async function runProject(
  project: ResolvedProject,
  options: RunProjectOptions,
): Promise<RunSummary> {
  const { bus, signal } = options
  const { orchestrator, core } = project.policy
  checkPattern(options.testNamePattern, core.testNamePatternFlags)

  const startedAt = performance.now()
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
    await bus.emit('run:start', info, [])
    const summary: RunSummary = {
      reason: signal?.aborted === true ? 'interrupted' : 'passed',
      files: [],
      unhandled: [],
      durationMs: performance.now() - startedAt,
    }
    await bus.emit('run:end', summary)
    return summary
  }

  const cache =
    options.cache === false
      ? undefined
      : (options.cache ?? createResultsCache(defaultCacheDir(project.rootDir)))
  const inputs: ScheduleInput[] = discovered.map((file) => {
    const history = cache?.get(project.name, file.relativePath)
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
  const queue: { readonly info: FileInfo; readonly file: DiscoveredFile }[] = ordered.flatMap(
    (input) => {
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
    },
  )

  await bus.emit(
    'run:start',
    info,
    queue.map((entry) => entry.info),
  )
  for (const entry of queue) await bus.emit('file:queued', entry.info)

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
  const workerEntry = options.entry ?? import.meta.resolve('@provino/orchestrator/worker/main')
  const stderr = options.stderr ?? process.stderr

  const unhandled: SerializedError[] = []
  const lastFile = new Map<number, FileInfo>()
  const pool = createPool(poolOptions, {
    transport: (poolKind) =>
      transportFor(poolKind, {
        entry: workerEntry,
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
        return cache?.get(project.name, path)?.durationMs
      },
    },
    onIdleEvents: createIdleDispatch({
      bus,
      fileOf: (workerId) => lastFile.get(workerId),
      onUnhandled: (error) => void unhandled.push(error),
    }),
    // Late output that couldn't be handed to the bus is an error of the run, not of a file.
    onError: (error) => void bus.emit('error', serializeError(error), 'coordinator'),
    ...(signal === undefined ? {} : { signal }),
  })

  /** One file, from its turn in the queue to its `file:end`; `undefined` if the run ended first. */
  async function runFile(entry: (typeof queue)[number]): Promise<FileResult | undefined> {
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
    const outcome = await pool.run({
      key,
      job,
      onStart: async (workerId) => {
        taken = performance.now()
        lastFile.set(workerId, entry.info)
        await bus.emit('file:start', entry.info, workerId)
      },
      onEvents: dispatch.handle,
    })
    const result = resultOf(entry.info, outcome, dispatch, performance.now() - taken)
    if (result === undefined) return undefined
    // A start failure says nothing about the file; a skipped file isn't remembered (as Jest's).
    if (outcome.type !== 'start-failed' && result.state !== 'skip') {
      cache?.record(project.name, entry.info.path, {
        durationMs: result.durationMs,
        failed: result.state === 'fail',
        tests: dispatch.tests,
        at: Date.now(),
      })
    }
    await bus.emit('file:end', result)
    return result
  }

  let results: readonly (FileResult | undefined)[]
  try {
    results = await Promise.all(queue.map((entry) => runFile(entry)))
  } finally {
    await pool.close()
  }
  try {
    await cache?.write()
  } catch (error) {
    // The history is a convenience: a read-only directory must not fail a run that passed.
    stderr.write(
      `Provino: could not write the results cache: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }

  const files = results.filter((result): result is FileResult => result !== undefined)
  const failed =
    files.some((file) => file.state === 'fail') ||
    (orchestrator.unhandledErrors === 'fail-run' && unhandled.length > 0)
  const summary: RunSummary = {
    reason: files.length < results.length ? 'interrupted' : failed ? 'failed' : 'passed',
    files,
    unhandled,
    durationMs: performance.now() - startedAt,
  }
  await bus.emit('run:end', summary)
  return summary
}

/** How a file's pool outcome becomes its result; `undefined` for a file the run never finished. */
function resultOf(
  file: FileInfo,
  outcome: PoolOutcome,
  dispatch: ReturnType<typeof createFileDispatch>,
  elapsedMs: number,
): FileResult | undefined {
  switch (outcome.type) {
    case 'aborted':
      return undefined
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
