// Runs a directory of test files through one worker with the real runtime (B10): the Jest
// dialect's policy and globals, the node environment, the setup file of the suite, and the
// coordinator side of B09 (`connectWorker` over a transport). Until `provino/node` exists this is
// the bench's own entry, as DECISIONS S4 allows; B11's coordinator replaces it.
import { relative } from 'node:path'
import { jestDialect, jestPolicy } from '@provino/dialect-jest'
import { connectWorker, fileIdOf, relativePosix, transportFor } from '@provino/orchestrator'
import { resolvePolicy, serializePolicy } from '@provino/policy'
import type {
  CoordinatorMethods,
  EnvironmentRef,
  FileJob,
  IsolationTier,
  PoolKind,
  SerializedProjectConfig,
  TaskId,
  WorkerEvent,
  WorkerExit,
  WorkerInit,
} from '@provino/types'
import { BenchError } from '../errors.ts'
import { createOrderChecker } from './order.ts'

/** The worker entry: the real runtime behind `startWorker`. */
const ENTRY: string = import.meta.resolve('@provino/orchestrator/worker/main')

/** The node environment, as a ref the worker can import (its module is absolute). */
const NODE_ENVIRONMENT: EnvironmentRef = {
  module: import.meta.resolve('@provino/env-node'),
  export: 'nodeEnvironment',
  options: {},
}

/**
 * The project name in the bench's task ids.
 * @public
 */
export const PROJECT_NAME = 'bench'

/**
 * The project config for a worker running Jest-flavoured suites: the Jest dialect's resolved
 * policy and globals, the node environment (or `environment`, an absolute ref), and
 * `setupFilesAfterEnv` (Jest's name for the suite's `setup.js`).
 */
function benchProjectConfig(
  rootDir: string,
  setupFilesAfterEnv: readonly string[],
  environment: EnvironmentRef = NODE_ENVIRONMENT,
): SerializedProjectConfig {
  const globals = jestDialect.globals
  if (globals === undefined) throw new BenchError('BENCH_USAGE', 'the Jest dialect has no globals')
  return {
    name: PROJECT_NAME,
    rootDir,
    ci: false,
    policy: serializePolicy(resolvePolicy(jestPolicy)),
    environment,
    globals: globals.factory,
    // As `config` builds it for the Jest dialect (B13c): its hoist policy and each module's `jest`.
    moduleScope: jestDialect.moduleScope?.factory ?? null,
    setupFiles: [],
    setupFilesAfterEnv,
    loader: {
      hoist: jestDialect.loader?.hoist ?? null,
      moduleScope: jestDialect.moduleScope?.names ?? [],
      extensions: ['.js', '.ts', '.mjs', '.cjs', '.json'],
      conditions: ['node'],
      tsconfig: false,
      mappers: [],
      typescript: 'oxc',
    },
  }
}

/**
 * What to run, and how.
 * @public
 */
export interface WorkerRunOptions {
  readonly rootDir: string
  /** Absolute paths of the test files, run in this order. */
  readonly files: readonly string[]
  readonly setupFilesAfterEnv?: readonly string[]
  /** The environment, by an absolute ref. Default: the node environment. */
  readonly environment?: EnvironmentRef
  /** The worker's transport. Default `inline`. */
  readonly pool?: PoolKind
  /** Default `registry`. */
  readonly isolation?: IsolationTier
  /** Keep every event in the result (the ordering fixtures read them). Default off. */
  readonly keepEvents?: boolean
  /** Where a worker's own stderr goes (a crash). Default: this process's. */
  readonly stderr?: NodeJS.WritableStream
}

/**
 * What one run found.
 * @public
 */
export interface WorkerRunResult {
  readonly pool: PoolKind
  readonly isolation: IsolationTier
  readonly files: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  /** Tests that ended: `passed + failed + skipped`. */
  readonly total: number
  /** What the ordering checker found; it also checks every event's file id against its job's. */
  readonly violations: readonly string[]
  /** The first few failures and unhandled errors, as `file › test: message`. */
  readonly failures: readonly string[]
  /** Unhandled errors: a test never charged them, so they are not in `failed`. */
  readonly unhandled: number
  /**
   * Errors on the files themselves (`file-end`'s result): a failing `afterAll`, a hook the file
   * registered outside any test. No test is charged with them, so they are not in `failed`.
   */
  readonly fileErrors: number
  /**
   * Global keys the files left behind that the environment could not remove (the sum of every
   * `fileDone.leakedGlobals`). A warning to the worker (decision D22), a failure of the bar: a
   * suite that leaks would make later files in a worker see what it left. A worker-scoped
   * environment (isolation `none`) reports at stop, with a `console` warning only, so it is not
   * counted here.
   */
  readonly leakedGlobals: number
  /** How the worker ended after `stop`. A clean one is `{ type: 'exit', code: 0 }`, inline too. */
  readonly exit: WorkerExit
  readonly elapsedMs: number
  /** Every event, in order, when `keepEvents` was set. */
  readonly events: readonly WorkerEvent[]
}

/** The file being run, set when its job is sent: its path as notes show it, and its tests’ names. */
interface RunningFile {
  readonly label: string
  readonly names: Map<TaskId, string>
}

const METHODS: CoordinatorMethods = {
  resolveSnapshotPath: async (file) => file,
  writeSnapshot: async () => {},
  readTimings: async () => undefined,
}

const MAX_FAILURES = 10

/**
 * The transports a worker can run on.
 * @public
 */
export const POOLS: readonly PoolKind[] = ['inline', 'threads', 'forks']

/**
 * Starts one worker of `pool`, runs `files` through it one at a time, stops it, and reports what
 * the coordinator saw: test counts, the ordering checker's violations, and the wall time (`local`).
 * @public
 */
export async function runWorkerFiles(options: WorkerRunOptions): Promise<WorkerRunResult> {
  const pool = options.pool ?? 'inline'
  const isolation = options.isolation ?? 'registry'
  const config = benchProjectConfig(
    options.rootDir,
    options.setupFilesAfterEnv ?? [],
    options.environment,
  )
  const init: WorkerInit = {
    key: {
      project: PROJECT_NAME,
      pool,
      environment: 'node',
      environmentOptionsHash: '',
      execArgvHash: '',
      envHash: '',
    },
    workerId: 1,
    isolation,
    provided: {},
    config,
  }
  const checker = createOrderChecker()
  const violations: string[] = []
  const failures: string[] = []
  const events: WorkerEvent[] = []
  const counts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    unhandled: 0,
    fileErrors: 0,
    leakedGlobals: 0,
  }
  let running: RunningFile | undefined
  const note = (failure: string): void => {
    if (failures.length < MAX_FAILURES) failures.push(failure)
  }

  const onEvent = (event: WorkerEvent): void => {
    if (options.keepEvents === true) events.push(event)
    checker.feed(event)
    const current = running
    if (current === undefined) {
      // No file is running: this is the worker stopping. Under `none` the worker-scoped
      // environment's teardown and the runtime's dispose run here, and a failure in either arrives
      // as an unhandled error no file owns. It counts like any other, or the bar passes falsely.
      if (event.type === 'unhandled-error') {
        counts.unhandled++
        note(`stop: unhandled ${event.origin}: ${event.error.message}`)
      }
      return
    }
    const { label } = current
    switch (event.type) {
      case 'file-collect-end':
        for (const task of event.tasks) {
          if (task.type === 'test') current.names.set(task.id, task.name)
        }
        for (const error of event.errors) note(`${label}: collection failed: ${error.message}`)
        return
      case 'file-end': {
        // A failing `afterAll` fails the file, not a test: no `test-end` carries it.
        counts.fileErrors += event.result.errors.length
        const [first] = event.result.errors
        if (first !== undefined) note(`${label}: file failed: ${first.message}`)
        return
      }
      case 'test-end': {
        const { state, errors } = event.result
        if (state === 'pass') counts.passed++
        else if (state === 'fail') {
          counts.failed++
          note(
            `${label} › ${current.names.get(event.id) ?? event.id}: ${errors[0]?.message ?? 'failed'}`,
          )
        } else counts.skipped++
        return
      }
      case 'unhandled-error':
        counts.unhandled++
        note(`${label}: unhandled ${event.origin}: ${event.error.message}`)
        return
      default:
        return
    }
  }

  const start = performance.now()
  const transport = await transportFor(pool, {
    entry: ENTRY,
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
  }).create(init)
  const connection = connectWorker(transport, {
    methods: METHODS,
    onEvents: (batch) => {
      for (const event of batch) onEvent(event)
    },
  })
  let finished = false
  let exit: WorkerExit
  try {
    for (const file of options.files) {
      const job: FileJob = {
        file,
        fileId: fileIdOf(PROJECT_NAME, relativePosix(options.rootDir, file)),
        updateSnapshots: 'none',
      }
      const current: RunningFile = { label: relative(options.rootDir, file), names: new Map() }
      running = current
      checker.feed({ type: 'run', fileId: job.fileId })
      const done = await connection.run(job)
      checker.feed({ type: 'fileDone' })
      if (done.leakedGlobals.length > 0) {
        counts.leakedGlobals += done.leakedGlobals.length
        note(`${current.label}: left globals behind: ${done.leakedGlobals.join(', ')}`)
      }
    }
    running = undefined
    // `terminate(false)` sends the worker its `stop`.
    checker.feed({ type: 'stop' })
    await transport.terminate(false)
    exit = await connection.exited
    finished = true
  } finally {
    // A run that threw leaves a worker behind; end it now rather than leak it.
    if (!finished) await transport.terminate(true)
  }
  const elapsedMs = performance.now() - start
  violations.push(...checker.finish())
  return {
    pool,
    isolation,
    files: options.files.length,
    ...counts,
    total: counts.passed + counts.failed + counts.skipped,
    violations,
    failures,
    exit,
    elapsedMs,
    events,
  }
}
