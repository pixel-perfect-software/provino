// `createRuntime`: one per worker. It wires the collector, the executor, the global API and the
// `LazyHost`, and runs files one at a time: collect (through the caller's `ImportFile`), build the
// tree, run it, and report every step to the `EventSink`.
import { relative, sep } from 'node:path'
import type { BehaviourLoader } from '@provino/policy'
import type {
  CorePolicy,
  DefaultRetry,
  DescribeRetry,
  DescribeRetryResult,
  EventSink,
  ImportFile,
  LazyHost,
  TaskId,
  TaskNode,
  TaskResult,
} from '@provino/types'
import { createApi, type RuntimeApi } from './collector/api.ts'
import { Collector } from './collector/collector.ts'
import { type FinalizeOptions, fileIdOf, finalize } from './collector/finalize.ts'
import { newFileState } from './collector/nodes.ts'
import { type CurrentTestService, currentTest, reportAsyncContext } from './current/current-test.ts'
import { listenForProcessErrors, ProcessErrors, type ProcessLike } from './errors/process-errors.ts'
import { CoreError, serializeError } from './errors.ts'
import { capturedTimers, createDeadlines, type RealTimers } from './executor/deadline.ts'
import {
  Executor,
  type Outcome,
  type RetryDefaults,
  type TimeoutDefaults,
  type TryTaskListener,
  type TryTaskListeners,
  taskResult,
} from './executor/executor.ts'
import type { FileState } from './internal/model.ts'
import { createRunRegistry } from './internal/run-registry.ts'
import { createLazyHost } from './lazy-host.ts'

/**
 * What a runtime is built from.
 * @public
 */
export interface RuntimeOptions {
  readonly policy: CorePolicy
  /** Loads `formatEachTitle`, `formatValue` and `orderHooks` (the worker's one loader). */
  readonly behaviours: BehaviourLoader
  readonly sink: EventSink
  /** Loads a test file; the worker passes the loader's import. */
  readonly importFile: ImportFile
  /** Test paths are reported relative to this directory, in POSIX form. */
  readonly rootDir: string
  /** Part of every task id. Default `''`. */
  readonly projectName?: string
  /** Whether this is a CI run (`allowOnly: 'not-in-ci'`). Default `false`. */
  readonly ci?: boolean
  /** Capture task and hook locations. Default `true`. */
  readonly locations?: boolean
  /** `-t`: tests whose joined full name doesn't match are skipped. */
  readonly testNamePattern?: string | RegExp
  /** Only these test ids run. */
  readonly testIds?: readonly string[]
  /** The timers deadlines use. Default: those global when core loaded. */
  readonly realTimers?: RealTimers
  /** A monotonic clock in ms. Default `performance.now`. */
  readonly now?: () => number
}

/**
 * What applies to one file only.
 * @public
 */
export interface RunFileOptions {
  /** Only tests (or suites) on these lines run (Vitest's `file:line`). */
  readonly lines?: readonly number[]
  /**
   * `-t` for this file only: replaces the runtime's `testNamePattern`. A string that is not a valid
   * regular expression fails the file (`CORE_INVALID_ARGUMENT`, the `SyntaxError` as its cause)
   * before it is imported. So does a value that is neither a string nor a `RegExp`, and a `testIds`
   * or `lines` that is not an array (the error names the option): `FileJob` crosses a link
   * unvalidated.
   */
  readonly testNamePattern?: string | RegExp
  /** Only these test ids run in this file: replaces the runtime's `testIds`. */
  readonly testIds?: readonly string[]
  /**
   * The file's id, assigned by the coordinator (D23; `FileJob.fileId`). Every event of the file and
   * every task id in it derives from this. Absent (a runtime used on its own), core computes it
   * from the project name and the file's path relative to the root. A value that is not a
   * non-empty string fails the file (`CORE_INVALID_ARGUMENT`), and its events then carry the
   * computed id.
   */
  readonly fileId?: TaskId
  /**
   * Collect the file and report each test's final mode without running anything: no hook and no
   * test body runs, and each test ends once as `queued` (it would run), `skip` or `todo`. Only
   * `true` is accepted; any other value fails the file (`CORE_INVALID_ARGUMENT`).
   */
  readonly collectOnly?: true
  /**
   * Shuffle every suite of this file with a generator built from this seed (`CorePolicy.shuffle`:
   * Jest's `--randomize`). It must be a number, taken as it is (the factory decides what a fraction
   * means), and the policy must have a `shuffle`; otherwise the file fails (`CORE_INVALID_ARGUMENT`)
   * before it is imported.
   */
  readonly shuffleSeed?: number
}

/**
 * A worker's test runtime.
 * @public
 */
export interface Runtime {
  /** The global functions (`describe`, `test`, hooks, …) a dialect re-exports. */
  readonly api: RuntimeApi
  readonly currentTest: CurrentTestService
  /** What `@provino/lazy` builds on. */
  readonly lazyHost: LazyHost
  /**
   * Collects and runs one test file; resolves with the file's result, whatever its tests do.
   * Rejects with `CORE_BUSY` while another file of this runtime is still collecting or running.
   */
  runFile(path: string, options?: RunFileOptions): Promise<TaskResult>
  /**
   * Registers a function that runs at the start of every attempt of every test (before its first
   * `beforeEach`, in the attempt's own async context): the hook point for work the runner owes the
   * test, such as the mock cleanup between tests (T4.10). A function that throws fails the
   * attempt. Returns the function that removes it.
   */
  onBeforeTryTask(listener: TryTaskListener): () => void
  /**
   * Registers a function that runs at the end of every attempt (after its last `afterEach` and
   * teardowns, before `onTestFinished`), told whether the attempt has failed: where the
   * assertion-count checks live (T7.8). A function that throws fails the attempt.
   */
  onAfterTryTask(listener: TryTaskListener): () => void
  /**
   * Listens on `target` (default: the process) for uncaught exceptions and rejections with no
   * handler, and charges each as `errors.lateErrors` says (T5.11). The worker calls it once;
   * returns the function that removes the listeners.
   */
  captureProcessErrors(target?: ProcessLike): () => void
  /**
   * Sets the timeout that a test or hook with none of its own gets, in place of the policy's, until
   * the file that is running ends (Jest's `jest.setTimeout`). It covers the tests declared before
   * the call too, and is read once when the run starts, after collection (circus copies it into
   * its state at `run_start`): a call during collection or in `setupFilesAfterEnv` takes effect, one
   * made inside a hook or a test body does not. `undefined` leaves the policy's in place. A dialect
   * maps its own odd values (Jest's `0`, `NaN` and negative numbers) before it calls.
   */
  setDefaultTimeout(ms: number | undefined): void
  /**
   * Sets the retry that every test with no `retry` of its own gets, until the file that is running
   * ends (Jest's `jest.retryTimes`): how many retries, how long to wait before each, whether they
   * run at once (`immediate`, whatever `retry.timing` says) and whether the errors of the attempts
   * that were retried are kept on the result (`logErrors`). It replaces any earlier call whole, as
   * Jest's globals are overwritten. A suite reads it when it starts running, after its `beforeAll`
   * hooks, and holds it for its own tests: a call from a hook or a test changes the suites that
   * start after it, not the running one. `undefined` clears it. A dialect maps its own odd values
   * before it calls; a count below 1 or that is not a finite number is no retry.
   */
  setDefaultRetry(retry: DefaultRetry | undefined): void
  /**
   * Sets the retry of the describe block being collected (the file's root at its top level): when a
   * test below fails, the block's hooks and every test below run again (Jest's `entireDescribe`).
   * A second call for the same block replaces the first. `started` when no block is open: the
   * file's run has begun, and a retry can no longer be set.
   */
  setDescribeRetry(retry: DescribeRetry): DescribeRetryResult
  /** Runs the worker teardowns (last first); rejects with an `AggregateError` if any failed. */
  dispose(): Promise<void>
}

/**
 * Builds a runtime. Async because it loads the policy's behaviour functions first, so
 * registration stays synchronous.
 * @public
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  reportAsyncContext()
  const { policy, sink } = options
  const now = options.now ?? (() => performance.now())
  const timers = options.realTimers ?? capturedTimers
  const deadlines = createDeadlines(policy.timeouts, timers, now)
  const projectName = options.projectName ?? ''
  const formatEachTitle = await options.behaviours.load(policy.formatEachTitle)
  const formatValue = await options.behaviours.load(policy.formatValue)
  const shuffleFactory =
    policy.shuffle === null ? undefined : await options.behaviours.load(policy.shuffle)
  const orderHooks =
    policy.orderHooks === null ? undefined : await options.behaviours.load(policy.orderHooks)
  const runs = createRunRegistry()
  const workerTeardowns: Array<() => unknown> = []
  const collector = new Collector({
    policy,
    formatEachTitle,
    locations: options.locations ?? true,
    onLateRegistration(error: CoreError, chargedTo: FileState | undefined) {
      sink.emit({
        type: 'unhandled-error',
        ownerId: chargedTo?.root.id ?? null,
        lastTestId: null,
        origin: 'late-registration',
        error: serializeError(error),
        t: now(),
      })
    },
  })
  const tryTask: TryTaskListeners = { before: [], after: [] }
  const defaults: TimeoutDefaults = { ms: undefined }
  const retryDefaults: RetryDefaults = { value: undefined }
  /** What `setDefaultTimeout` last asked for; `defaults.ms` takes it when the run starts. */
  let requestedTimeout: number | undefined
  const processErrors: ProcessErrors = new ProcessErrors({
    lateErrors: policy.errors.lateErrors,
    // Through the executor: an error charged to a test inside a describe attempt waits with it.
    emit: (event) => executor.emitCharged(event),
    now,
    frame: () => currentTest.get(),
    runningAttempt: (frame) => executor.attemptFor(frame),
    lastTestId: () => executor.lastTestId,
  })
  const executor: Executor = new Executor({
    policy,
    orderHooks,
    sink,
    deadlines,
    timers,
    now,
    runs,
    formatValue,
    processErrors,
    tryTask,
    locations: options.locations ?? true,
    defaults,
    retryDefaults,
  })
  const pattern = options.testNamePattern
  const finalizeOptions: Omit<FinalizeOptions, 'lines'> = {
    policy,
    projectName,
    ci: options.ci ?? false,
    testNamePattern:
      pattern === undefined ? undefined : toRegExp(pattern, policy.testNamePatternFlags),
    testIds: options.testIds === undefined ? undefined : new Set(options.testIds),
  }

  /**
   * The runtime's filters, with the ones this file's options give instead. `FileJob` crosses a link
   * unvalidated, so each option is checked here: a wrong type, or a `testNamePattern` string that
   * is not a valid regular expression, throws a `CORE_INVALID_ARGUMENT` naming the option.
   */
  function finalizeOptionsFor(relativePath: string, fileOptions: RunFileOptions): FinalizeOptions {
    const { testNamePattern, testIds, lines, fileId, collectOnly } = fileOptions
    const invalid = (option: string, reason: string, cause?: unknown): CoreError =>
      new CoreError(
        'CORE_INVALID_ARGUMENT',
        `Invalid ${option} for ${relativePath}: ${reason}`,
        cause === undefined ? undefined : { cause },
      )
    let filePattern: RegExp | undefined
    if (testNamePattern !== undefined) {
      if (typeof testNamePattern !== 'string' && !(testNamePattern instanceof RegExp)) {
        throw invalid(
          'testNamePattern',
          `expected a string or a RegExp, got ${describeType(testNamePattern)}`,
        )
      }
      try {
        filePattern = toRegExp(testNamePattern, policy.testNamePatternFlags)
      } catch (cause) {
        throw invalid(
          'testNamePattern',
          cause instanceof Error ? cause.message : String(cause),
          cause,
        )
      }
    }
    if (testIds !== undefined && !Array.isArray(testIds)) {
      throw invalid('testIds', `expected an array of test ids, got ${describeType(testIds)}`)
    }
    if (lines !== undefined && !Array.isArray(lines)) {
      throw invalid('lines', `expected an array of line numbers, got ${describeType(lines)}`)
    }
    if (fileId !== undefined && !isFileId(fileId)) {
      throw invalid(
        'fileId',
        `expected a non-empty string, got ${fileId === '' ? 'an empty string' : describeType(fileId)}`,
      )
    }
    if (collectOnly !== undefined && collectOnly !== true) {
      throw invalid('collectOnly', `expected true, got ${describeType(collectOnly)}`)
    }
    return {
      ...finalizeOptions,
      ...(fileId === undefined ? {} : { fileId }),
      ...(filePattern === undefined ? {} : { testNamePattern: filePattern }),
      ...(testIds === undefined ? {} : { testIds: new Set(testIds) }),
      lines: lines === undefined ? undefined : new Set(lines),
    }
  }

  /**
   * The shuffle of one file, built from its `shuffleSeed`, or `undefined` for the declared order.
   * A seed that is not a number, or one given to a policy that cannot shuffle, is refused.
   */
  function shuffleFor(
    relativePath: string,
    fileOptions: RunFileOptions,
  ): (<T>(items: T[]) => T[]) | undefined {
    const { shuffleSeed } = fileOptions
    if (shuffleSeed === undefined) return undefined
    const invalid = (reason: string): CoreError =>
      new CoreError('CORE_INVALID_ARGUMENT', `Invalid shuffleSeed for ${relativePath}: ${reason}`)
    // Any number: what a fraction or NaN means is the factory's (Jest's pure-rand truncates it).
    if (typeof shuffleSeed !== 'number') {
      throw invalid(`expected a number, got ${describeType(shuffleSeed)}`)
    }
    if (shuffleFactory === undefined) {
      throw invalid('this policy has no `shuffle`, so the run cannot be randomized')
    }
    return shuffleFactory(shuffleSeed)
  }

  /**
   * Collects a file, then calls the `onCollected` listeners. `false` when either failed: the file
   * then reports no tasks, as both runners do for a collection failure.
   */
  async function collect(file: FileState): Promise<boolean> {
    let collected = true
    try {
      await collector.collect(file, () => options.importFile(file.path))
    } catch (error) {
      collected = false
      file.errors.push(error)
    }
    collector.close(file)
    if (!(await notifyCollected(file))) collected = false
    if (!collected) file.root.children.length = 0
    return collected
  }

  /** Calls each `onCollected` listener, awaiting what it returns; `false` when one failed. */
  async function notifyCollected(file: FileState): Promise<boolean> {
    let ok = true
    for (const listener of file.onCollected) {
      try {
        // A listener validates what was collected; one that never settles must not hang the file.
        await deadlines.call(() => listener(file.handle), {
          what: 'listener',
          timeoutMs: policy.timeouts.hook,
          catchSyncOverrun: false,
        })
      } catch (error) {
        ok = false
        file.errors.push(error)
      }
    }
    return ok
  }

  async function runFile(path: string, fileOptions: RunFileOptions = {}): Promise<TaskResult> {
    const busy = collector.file
    if (busy !== undefined) {
      throw new CoreError('CORE_BUSY', `"${busy.path}" is still collecting or running`)
    }
    const relativePath = relative(options.rootDir, path).split(sep).join('/')
    const file = newFileState(path, relativePath, new AbortController().signal)
    const fileId = isFileId(fileOptions.fileId)
      ? fileOptions.fileId
      : fileIdOf(projectName, relativePath)
    const start = now()
    processErrors.startFile(fileId)
    sink.emit({ type: 'file-collect-start', fileId, path: relativePath, t: start })
    let outcome: Outcome = 'fail'
    let childOrder: readonly TaskId[] | undefined
    try {
      let collected = false
      let tasks: TaskNode[] = []
      let shuffle: (<T>(items: T[]) => T[]) | undefined
      try {
        // The filters are built before the import: an invalid per-file filter skips it. Whatever
        // throws here (that, or `finalize`), the file reports no tasks and the error, is not run,
        // and still gets its `file-collect-end` and `file-end`.
        const filters = finalizeOptionsFor(relativePath, fileOptions)
        shuffle = shuffleFor(relativePath, fileOptions)
        collected = await collect(file)
        tasks = finalize(file, filters)
      } catch (error) {
        collected = false
        file.errors.push(error)
      }
      const errors = file.errors.map(serializeError)
      sink.emit({ type: 'file-collect-end', fileId, tasks, errors, t: now() })
      if (collected) {
        // circus's `run_start`: from here a call to `setDefaultTimeout` changes nothing.
        defaults.ms = requestedTimeout
        if (fileOptions.collectOnly === true) {
          outcome = executor.collectFile(file)
        } else {
          outcome = await executor.runFile(file, shuffle)
          childOrder = executor.rootOrder
        }
      }
    } catch (error) {
      file.errors.push(error)
    } finally {
      // The file's own teardowns run whatever happened above: a failed collection, a failed
      // listener, a root `aroundAll` that never ran the suite.
      file.errors.push(...(await deadlines.drain(file.handle.teardowns)))
      collector.release(file)
      defaults.ms = undefined
      retryDefaults.value = undefined
      requestedTimeout = undefined
      // A rejection still held belongs to the task that made it; this is where it is charged.
      processErrors.flush()
    }
    const failed = file.errors.length > 0 || outcome === 'fail' || processErrors.failsFile
    const end = now()
    const result = taskResult(failed ? 'fail' : outcome, start, end, file.errors, {
      ...(childOrder === undefined ? {} : { childOrder }),
    })
    sink.emit({ type: 'file-end', fileId, result, t: end })
    return result
  }

  return {
    api: createApi(collector),
    currentTest,
    lazyHost: createLazyHost({ collector, runs, workerTeardowns, workerSlots: new Map() }),
    runFile,
    onBeforeTryTask: (listener) => addListener(tryTask.before, listener),
    onAfterTryTask: (listener) => addListener(tryTask.after, listener),
    captureProcessErrors: (target = process) => listenForProcessErrors(processErrors, target),
    setDefaultTimeout(ms) {
      requestedTimeout = ms
    },
    setDefaultRetry(retry) {
      retryDefaults.value = retry
    },
    setDescribeRetry(retry) {
      const suite = collector.collecting()
      if (suite === undefined) return 'started'
      suite.describeRetry = retry
      return 'set'
    },
    async dispose(): Promise<void> {
      const errors = await deadlines.drain(workerTeardowns)
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Worker teardowns failed')
      }
    },
  }
}

/** Adds a listener to a list and returns the function that takes it out. */
function addListener(list: TryTaskListener[], listener: TryTaskListener): () => void {
  list.push(listener)
  return () => {
    const at = list.indexOf(listener)
    if (at !== -1) list.splice(at, 1)
  }
}

/** Whether a coordinator-assigned file id is usable: a non-empty string. */
function isFileId(value: unknown): value is TaskId {
  return typeof value === 'string' && value !== ''
}

/** What a value is, for an error message: `typeof`, except that `null` is not an object. */
function describeType(value: unknown): string {
  return value === null ? 'null' : typeof value
}

/** `-t` as a `RegExp`: a string is compiled with the policy's flags. */
function toRegExp(pattern: string | RegExp, flags: string): RegExp {
  return typeof pattern === 'string' ? new RegExp(pattern, flags) : pattern
}
