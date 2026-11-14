// The executor (T5.6): walks a collected file and runs it under `CorePolicy`, emitting
// `RuntimeEvent`s. One code path; every Jest/Vitest difference is a policy value (Track 5
// decisions 1 and 3). Reference behaviour: jest-circus 30.5's `_runTestsForDescribeBlock`/
// `_runTest` and Vitest 5.0's `runSuite`/`runTest`.
//
// One test attempt, in order: `aroundEach` (outer → inner) wraps `beforeEach` (parent → child),
// the body, `afterEach` (child → parent), the teardowns `beforeEach` returned, `LazyHost`
// teardowns (last first), `onTestFinished` (last first), then `onTestFailed` if it failed. After
// the around chain: the `LazyHost` teardowns the around hooks added, then, under
// `status.expectFail: 'attempt'`, the reversal of a `.fails` test's result.
import type {
  CorePolicy,
  DefaultRetry,
  DescribeRetry,
  EventSink,
  FileTask,
  FormatValue,
  Frame,
  HookKind,
  LifecycleEvent,
  LifecycleListener,
  OrderHooks,
  RuntimeEvent,
  RuntimeHookKind,
  SkipReason,
  SourceLocation,
  SuiteHandle,
  SuiteTask,
  TaskId,
  TaskInfo,
  TaskResult,
  TaskState,
  TestContext,
  TestRunHandle,
  TestTask,
} from '@provino/types'
import { CALLER_FRAMES, captureSite, parseSite, TEST_FILE_FRAMES } from '../collector/location.ts'
import { type RetrySpec, retryCount, retryDelay } from '../collector/retry.ts'
import { newStore, runInStore, setRunningFrame } from '../current/current-test.ts'
import type { ProcessErrors } from '../errors/process-errors.ts'
import { CoreError, serializeError } from '../errors.ts'
import type {
  AttemptState,
  FileState,
  HookNode,
  Store,
  SuiteNode,
  TestCallback,
  TestNode,
  UserFn,
} from '../internal/model.ts'
import type { RunRegistry } from '../internal/run-registry.ts'
import { type AroundCall, runAround } from './around.ts'
import { type ContextEnv, createTestContext, SkipSignal } from './context.ts'
import { type Deadlines, isBounded, type RealTimers, resolveTimeout, sleep } from './deadline.ts'
import { type InvokeEnv, invoke } from './invoke.ts'
import { createLimiter, type Limiter, unlimited } from './limiter.ts'

/** What the executor needs from the runtime. */
export interface ExecutorConfig {
  readonly policy: CorePolicy
  readonly orderHooks: OrderHooks | undefined
  readonly sink: EventSink
  /** Every user call's deadline. */
  readonly deadlines: Deadlines
  /** The timers the around hooks' phases use. */
  readonly timers: RealTimers
  readonly now: () => number
  /** Each test context's run, for `LazyHost.runOf`. */
  readonly runs: RunRegistry
  /** `CorePolicy.formatValue`, loaded: prints a value inside a message the runtime builds. */
  readonly formatValue: FormatValue
  /** Who an error the code did not handle is charged to (T5.11). */
  readonly processErrors: ProcessErrors
  /** The listeners `onBeforeTryTask`/`onAfterTryTask` registered: the runtime's own arrays. */
  readonly tryTask: TryTaskListeners
  /** Whether to capture locations (`ctx.annotate` records where it was called). */
  readonly locations: boolean
  /** The timeout a test or hook with none of its own gets, when the file set one (`jest.setTimeout`). */
  readonly defaults: TimeoutDefaults
  /** The retry a test with none of its own gets, when the file set one (`jest.retryTimes`). */
  readonly retryDefaults: RetryDefaults
}

/**
 * A retry set while a file runs, for every test that declares none (`jest.retryTimes`). A suite
 * reads it when it starts running, after its `beforeAll` hooks (jest-circus reads the global in
 * `_runTestsForDescribeBlockOnce`); a retry reads `keepEarlierErrors` when it happens (jest-circus
 * reads `logErrorsBeforeRetry` on `test_retry`).
 */
export interface RetryDefaults {
  value: DefaultRetry | undefined
}

/**
 * A default timeout set while a file runs, in place of the policy's (`jest.setTimeout`). It covers
 * the tests declared before the call too, because it is read when a test runs.
 */
export interface TimeoutDefaults {
  ms: number | undefined
}

/** What a try-task listener is told about the attempt it brackets. */
export interface TryTaskInfo {
  readonly test: TestTask
  /**
   * The attempt's test context, the same object its hooks and body get. A getter, built on the
   * first read: it is not an own key, so a spread of the info or `Object.keys` does not carry it.
   */
  readonly ctx: TestContext
  readonly attempt: number
  readonly repeat: number
  /** `false` in `onBeforeTryTask`; in `onAfterTryTask`, whether the attempt has failed so far. */
  readonly failed: boolean
  /**
   * Adds an error to the attempt, as one of its own: a listener with several (two soft failures)
   * reports each, where a thrown value is one error.
   */
  fail(error: unknown): void
}

/** Called around an attempt's hooks and body, in the attempt's own async context. */
export type TryTaskListener = (info: TryTaskInfo) => void | Promise<void>

/** The two lists of listeners. */
export interface TryTaskListeners {
  readonly before: TryTaskListener[]
  readonly after: TryTaskListener[]
}

/** The outcome of one task. */
export type Outcome = 'pass' | 'fail' | 'skip' | 'todo'

/** One file while it runs. */
interface FileRun {
  readonly file: FileState
  readonly fileId: TaskId
  /** Whether the file has had the warning for an ignored function `retry.condition` (once a file). */
  warnedIgnoredCondition: boolean
  /** The file's shuffle (a randomized run), one generator for all its suites; `undefined` for the declared order. */
  readonly shuffle: (<T>(items: T[]) => T[]) | undefined
  /** The suites already shuffled, with the order of their children: each is shuffled once. */
  readonly shuffled: Map<SuiteNode, readonly TaskId[]>
}

/**
 * What a test is retried with: its `retry` (or the file's default), and, whether it retries after
 * the suite's other tests, not at once (`retry.timing`). Built once a test.
 */
type RetryPlan = RetrySpec & { readonly deferred: boolean }

/** The plan of a test that is never retried: its own, and the file's, have none. */
const NO_RETRY: RetryPlan = Object.freeze({
  count: 0,
  delay: 0,
  condition: undefined,
  ignoredFunction: undefined,
  deferred: false,
})

/** What happens to a failed attempt: it is retried, or it ends the test (with what a condition threw). */
interface RetryDecision {
  readonly willRetry: boolean
  /** What a `condition` that threw threw: a failure of the test as well. */
  readonly conditionFailure: unknown
}

const RETRY: RetryDecision = Object.freeze({ willRetry: true, conditionFailure: undefined })
const STOP: RetryDecision = Object.freeze({ willRetry: false, conditionFailure: undefined })

/** No arguments: shared by every call that passes none, since `invoke` only reads them. */
const NO_ARGS: readonly unknown[] = Object.freeze([])

/** The tests of a concurrent group when nothing listens. */
const NO_TESTS: readonly TestNode[] = Object.freeze([])

/** What a test's attempts have left so far. */
interface Progress {
  readonly start: number
  /** The errors of the attempts that were retried, when the result keeps them. */
  readonly retryErrors: unknown[]
  /** The errors of the attempt that ended the test. */
  readonly failures: unknown[]
  attempts: number
  /** Attempts the test had already run in discarded describe attempts (`setDescribeRetry`). */
  readonly attemptBase: number
  repeatIndex: number
  skipped: AttemptState['skipped']
  /** Milliseconds between the test's start and end that were not its own: its retries waited for the suite's other tests. */
  parkedMs: number
}

/** The rest of a test whose first attempt failed and whose retries wait for the end of its suite. */
type Resume = () => Promise<Outcome>

/** What a suite passes to its children. */
interface Scope {
  /** `beforeAll` errors attached to every test below (`beforeAllError: 'attach-to-tests'`). */
  readonly attached: readonly unknown[]
  /** No hooks run below (`nestedHooksAfterBeforeAllError: 'skip'` after such an error). */
  readonly skipHooks: boolean
  /** Inside a concurrent group: the sync pointer stays unset. */
  readonly concurrent: boolean
  /** The file's default retry as the suite read it when it started running (`jest.retryTimes`). */
  readonly fileRetry: DefaultRetry | undefined
  /** The describe attempt this runs in (`setDescribeRetry`), innermost; `undefined` outside any. */
  readonly hold: Hold | undefined
}

/**
 * One attempt of a describe block with a retry of its own (`setDescribeRetry`). What it reports
 * waits here until it is known whether the attempt stands. Each attempt has its own, carried down
 * in the scope, so blocks that run side by side (concurrent siblings) keep theirs apart.
 */
interface Hold {
  /** The attempt's events: attempt starts and ends, task ends, errors charged late to its tests. */
  readonly events: RuntimeEvent[]
  /** The attempt this one runs inside, which takes its events if it stands; `undefined` for the outermost. */
  readonly parent: Hold | undefined
  /** The tasks the outermost retried block has started: a task's start is reported once. */
  readonly started: Set<TaskId>
  /** The errors the tests below carried before the attempt began (an outer `beforeAll`'s). */
  readonly inherited: readonly unknown[]
  /**
   * The errors of the tests that failed in the attempt, and of the attempts below it that stood
   * (the inherited ones included): any other than `inherited` is one the attempt added (circus's
   * `hasErrorsAddedDuringAttempt` over `errorsBeforeAttempt`).
   */
  readonly failures: unknown[]
  /** Whether the attempt is still running; a closed one hands an error charged late to its parent. */
  open: boolean
}

/** A teardown a hook returned, with the hook it came from. */
interface Teardown {
  readonly fn: UserFn
  readonly owner: SuiteNode
  readonly ordinal: number
}

type Group = { readonly concurrent: boolean; readonly nodes: ReadonlyArray<SuiteNode | TestNode> }

/** How a user call ended. */
type CallResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

const PASSED: CallResult = { ok: true, value: undefined }

/** One hook-like call, as its store and its `hook-start`/`hook-end` events describe it. */
interface HookCall {
  readonly kind: RuntimeHookKind
  readonly owner: SuiteNode
  readonly ordinal: number
  /** The declared hook it calls; `undefined` for a teardown or a test callback. */
  readonly hook: HookNode | undefined
  readonly location: SourceLocation | null
  /** The test attempt it belongs to; `undefined` for a suite hook. */
  readonly attempt: AttemptState | undefined
}

/** The each-hooks every attempt of a test in one suite meets. Fixed once the file is collected. */
interface EachHooks {
  /** The levels with `beforeEach` hooks, from the file root down. */
  readonly beforeEach: readonly SuiteNode[]
  /** The levels with `afterEach` hooks, from the innermost suite up. */
  readonly afterEach: readonly SuiteNode[]
  /** Every level's `aroundEach` hooks, outermost first. */
  readonly aroundEach: readonly HookNode[]
}

const NO_EACH_HOOKS: EachHooks = { beforeEach: [], afterEach: [], aroundEach: [] }

/** Runs collected files. One per runtime. */
export class Executor {
  readonly #config: ExecutorConfig
  readonly #policy: CorePolicy
  readonly #deadlines: Deadlines
  /** `concurrency.limitHooks`: hooks and bodies share one `maxConcurrency` limit. */
  readonly #calls: Limiter
  /** With `limitHooks`, tests across groups share one `maxConcurrency` limit too (Vitest). */
  readonly #tests: Limiter
  /** Each suite's `EachHooks`, built for its first test. */
  readonly #eachHooks: WeakMap<SuiteNode, EachHooks> = new WeakMap()
  /** The attempt each test is running now (T5.11 charges an error to it). */
  readonly #running = new Map<TaskId, AttemptState>()
  /** What every test context is built from. */
  readonly #contextEnv: ContextEnv
  /** `#contextOf`, for a `TryInfo` to call. */
  readonly #contextFor: (attempt: AttemptState) => TestContext = (attempt) =>
    this.#contextOf(attempt)
  /** Reports a `done(reason)` that came after its call was over (`late-done`). */
  readonly #lateDone: (error: Error) => void
  /** The `InvokeEnv` of a call outside any test (a suite hook), which is never over. */
  readonly #outsideTestEnv: InvokeEnv
  /** The describe attempt each test ran in last, for an error charged to it after it ended. */
  readonly #heldTests = new Map<TaskId, Hold>()
  /** How many attempts each test has run in describe attempts so far. */
  readonly #describeAttempts = new Map<TaskId, number>()
  /** What `rootOrder` reports. */
  #rootOrder: readonly TaskId[] | undefined
  /** The test that started last. */
  #lastTestId: TaskId | null = null
  /** The path of the file running now, for the location of a `ctx.annotate` call. */
  #filePath: string | undefined
  /** The file's lifecycle listener (an environment's `onTestEvent`); `undefined` costs nothing. */
  #life: LifecycleListener | undefined
  /**
   * What the listener threw at a run event that ends the file (`#tell`): from then on no listener
   * call is made and no suite's `afterAll` runs, as circus's `dispatch` throws out of the run.
   */
  #aborted: { readonly error: unknown } | undefined

  constructor(config: ExecutorConfig) {
    this.#config = config
    this.#policy = config.policy
    this.#contextEnv = {
      doneDeprecatedMessage: config.policy.doneDeprecatedMessage,
      emit: (event) => config.sink.emit(event),
      now: config.now,
      callerLocation: (entry) => this.#callerLocation(entry),
    }
    this.#lateDone = (error) => config.processErrors.report('late-done', error)
    this.#outsideTestEnv = {
      policy: config.policy,
      format: config.formatValue,
      over: () => false,
      late: this.#lateDone,
    }
    this.#deadlines = config.deadlines
    const shared = config.policy.concurrency.limitHooks
    this.#calls = shared ? createLimiter(config.policy.maxConcurrency) : unlimited
    this.#tests = shared ? createLimiter(config.policy.maxConcurrency) : unlimited
  }

  /**
   * Runs a collected (finalized) file. File-level errors land in `file.errors`; the root's outcome
   * is returned. The file's own teardowns (`FileHandle.teardowns`) are the caller's to run.
   */
  async runFile(file: FileState, shuffle?: <T>(items: T[]) => T[]): Promise<Outcome> {
    const run: FileRun = {
      file,
      fileId: file.root.id,
      warnedIgnoredCondition: false,
      shuffle,
      shuffled: new Map(),
    }
    this.#rootOrder = undefined
    this.#filePath = file.path
    this.#heldTests.clear()
    this.#describeAttempts.clear()
    const life = file.lifecycle
    this.#life = life
    this.#aborted = undefined
    try {
      if (life !== undefined) {
        await this.#tell(life, {
          type: 'run-start',
          timeoutMs: this.#config.defaults.ms ?? this.#policy.timeouts.test,
        })
      }
      const outcome = await this.#runSuite(run, file.root, {
        attached: [],
        skipHooks: false,
        concurrent: false,
        fileRetry: undefined,
        hold: undefined,
      })
      this.#rootOrder = run.shuffled.get(file.root)
      if (life !== undefined) await this.#tell(life, { type: 'run-end' })
      return outcome
    } finally {
      this.#life = undefined
    }
  }

  /**
   * Calls the listener at a run event. A throw ends the file's run (circus's `dispatch` throws out
   * of `run`, `run.ts`): it is kept, so no later call is made and no `afterAll` runs, and rethrown
   * for the runtime to fail the file with.
   */
  async #tell(life: LifecycleListener, event: LifecycleEvent): Promise<void> {
    if (this.#aborted !== undefined) return
    try {
      await life(event)
    } catch (error) {
      this.#aborted = { error }
      throw error
    }
  }

  /**
   * Calls the listener where circus dispatches inside the call's own `try` (`hook_success`,
   * `test_fn_success`, `run.ts` L467-L481, L497-L519): what it throws is returned, for the caller to
   * make the hook's or the body's failure, and does not end the run.
   */
  async #tellInside(
    life: LifecycleListener,
    event: LifecycleEvent,
  ): Promise<{ readonly error: unknown } | undefined> {
    if (this.#aborted !== undefined) return undefined
    try {
      await life(event)
      return undefined
    } catch (error) {
      return { error }
    }
  }

  /** Rethrows what ended the run, after a user `try` (an around hook's) may have caught it. */
  #rethrowAborted(): void {
    if (this.#aborted !== undefined) throw this.#aborted.error
  }

  /** The order a randomized run put the last file's top-level tasks in; `undefined` when it kept the declared one. */
  get rootOrder(): readonly TaskId[] | undefined {
    return this.#rootOrder
  }

  /**
   * A collect-only pass (`--collectTests`): no hook, body or timer runs. Each test in declaration
   * order starts and ends once with the mode `finalize` gave it: `skip` (skipped, unfocused or
   * deselected by name), `todo`, or `queued` for a test that would run. A task that is blocked
   * is reported by what it would do, not by its block.
   */
  collectFile(file: FileState): Outcome {
    this.#filePath = file.path
    const visit = (suite: SuiteNode): void => {
      for (const child of suite.children) {
        if (child.type !== 'test') {
          visit(child)
          continue
        }
        const t = this.#now()
        this.#lastTestId = child.id
        this.#emit({ type: 'test-start', id: child.id, t })
        const state: TaskState =
          child.mode === 'run' || child.mode === 'only' ? 'queued' : child.mode
        const extra: ResultExtra | undefined =
          state === 'skip' ? { skipReason: child.skipReason ?? 'unknown' } : undefined
        this.#endTask(undefined, 'test-end', child.id, state, t, [], extra)
      }
    }
    visit(file.root)
    return 'pass'
  }

  /** The attempt a frame belongs to while it runs, or `undefined` once it is over. */
  attemptFor(frame: Frame): AttemptState | undefined {
    if (frame.test === null) return undefined
    const attempt = this.#running.get(frame.test.id)
    return attempt !== undefined &&
      attempt.state !== 'done' &&
      attempt.frame.attempt === frame.attempt &&
      attempt.frame.repeat === frame.repeat
      ? attempt
      : undefined
  }

  /** The test that started last. */
  get lastTestId(): TaskId | null {
    return this.#lastTestId
  }

  /** Where `entry` was called from, as a task's location is captured. */
  #callerLocation(entry: (...args: never[]) => unknown): SourceLocation | null {
    const inFile = this.#policy.locationFrame === 'test-file'
    const site = captureSite(
      entry,
      this.#config.locations,
      inFile ? TEST_FILE_FRAMES : CALLER_FRAMES,
    )
    return parseSite(site, inFile ? this.#filePath : undefined)
  }

  // ---- suites -------------------------------------------------------------------------------

  async #runSuite(run: FileRun, suite: SuiteNode, scope: Scope): Promise<Outcome> {
    const isRoot = suite.parent === null
    const start = this.#now()
    if (!isRoot) this.#start(scope.hold, 'suite-start', suite.id, start)
    let errors: unknown[] = []
    let children: Outcome[] = []
    if (suite.blocked !== undefined) {
      errors.push(suite.blocked)
      this.#skipBelow(suite, scope.hold)
    } else if (suite.describeRetry !== undefined) {
      const retried = await this.#runRetried(run, suite, scope, suite.describeRetry)
      children = retried.children
      errors = retried.errors
    } else {
      children = await this.#runSuiteBody(run, suite, scope, errors)
    }
    if (suite.emptyError !== undefined && suite.mode === 'run') errors.push(suite.emptyError)
    const outcome = suiteOutcome(suite, errors, children)
    if (isRoot) run.file.errors.push(...errors)
    else {
      const childOrder = run.shuffled.get(suite)
      this.#endTask(
        scope.hold,
        'suite-end',
        suite.id,
        outcome,
        start,
        errors,
        childOrder === undefined ? undefined : { childOrder },
      )
    }
    return outcome
  }

  /**
   * A describe block with a retry of its own (jest-circus's `_runTestsForDescribeBlock`): the block
   * runs, hooks and all; if a test below got an error the attempt added and retries are left, what
   * the attempt reported is dropped and the block runs again. An error a test had before the
   * attempt (an outer `beforeAll`'s, attached to it) is not one it added, so it retries nothing. The
   * last attempt's results stand, with the errors of the dropped ones when `logErrorsBeforeRetry`
   * says so. An error nobody owns (a failed `afterAll`, an uncaught exception outside a test) ends
   * the retries, as jest-circus's `unhandledErrors` and `processErrorGeneration` do.
   */
  async #runRetried(
    run: FileRun,
    suite: SuiteNode,
    scope: Scope,
    retry: DescribeRetry,
  ): Promise<{ readonly children: Outcome[]; readonly errors: unknown[] }> {
    let left = Number.isFinite(retry.numRetries) ? Math.max(0, Math.trunc(retry.numRetries)) : 0
    const wait = retry.waitBeforeRetry ?? 0
    const parent = scope.hold
    const started = parent?.started ?? new Set<TaskId>()
    /** The errors of dropped attempts, by test. */
    const dropped = new Map<TaskId, SerializedError[]>()
    for (;;) {
      const hold: Hold = {
        events: [],
        parent,
        started,
        inherited: scope.attached,
        failures: [],
        open: true,
      }
      const fileErrors = run.file.errors.length
      const unowned = this.#config.processErrors.unowned
      const errors: unknown[] = []
      let children: Outcome[]
      try {
        children = await this.#runSuiteBody(run, suite, { ...scope, hold }, errors)
      } finally {
        hold.open = false
      }
      const added = hold.failures.some((error) => !hold.inherited.includes(error))
      const unhandled =
        run.file.errors.length > fileErrors || this.#config.processErrors.unowned > unowned
      if (!added || unhandled || left <= 0) {
        parent?.failures.push(...hold.failures)
        for (const event of hold.events) this.#emit(withDropped(event, dropped), parent)
        return { children, errors }
      }
      this.#drop(hold, retry.logErrorsBeforeRetry === true ? dropped : undefined)
      // Only `RuntimeEvent`s are dropped: the lifecycle saw every attempt, as circus's handlers do,
      // and hears `describe_retry` after the errors are cleared, before the wait (`run.ts` L159-L171).
      const life = this.#life
      if (life !== undefined) {
        await this.#tell(life, {
          type: 'suite-retry',
          ref: suite,
          keepEarlierErrors: retry.logErrorsBeforeRetry === true,
        })
      }
      if (wait > 0) await sleep(this.#config.timers, wait)
      left--
    }
  }

  /**
   * Drops a describe attempt: its task ends and the errors charged late to its tests are
   * discarded (kept in `dropped`, by test, when `logErrorsBeforeRetry` asks), and each of its test
   * attempts is reported as one that was retried, as circus reports every `test_done`.
   */
  #drop(hold: Hold, dropped: Map<TaskId, SerializedError[]> | undefined): void {
    const keep = (id: TaskId, errors: readonly SerializedError[]): void => {
      if (dropped === undefined || errors.length === 0) return
      const kept = dropped.get(id) ?? []
      kept.push(...errors)
      dropped.set(id, kept)
    }
    for (const event of hold.events) {
      switch (event.type) {
        case 'test-end':
          keep(event.id, [...event.result.errors, ...event.result.retryErrors])
          break
        case 'suite-end':
          break
        case 'unhandled-error':
          if (event.ownerId !== null) {
            this.#config.processErrors.forget(event.ownerId)
            keep(event.ownerId, [event.error])
          }
          break
        case 'test-attempt-end':
          this.#emit(event.willRetry ? event : { ...event, willRetry: true }, hold.parent)
          break
        default:
          this.#emit(event, hold.parent)
      }
    }
  }

  /** The suite's run, between the lifecycle's `suite-start` and `suite-end` (each attempt of a retried block has both). */
  #runSuiteBody(
    run: FileRun,
    suite: SuiteNode,
    scope: Scope,
    errors: unknown[],
  ): Promise<Outcome[]> {
    const life = this.#life
    if (life === undefined) return this.#runSuiteSteps(run, suite, scope, errors)
    return this.#runSuiteWithLifecycle(life, run, suite, scope, errors)
  }

  async #runSuiteWithLifecycle(
    life: LifecycleListener,
    run: FileRun,
    suite: SuiteNode,
    scope: Scope,
    errors: unknown[],
  ): Promise<Outcome[]> {
    await this.#tell(life, { type: 'suite-start', ref: suite })
    const outcomes = await this.#runSuiteSteps(run, suite, scope, errors)
    await this.#tell(life, { type: 'suite-end', ref: suite })
    return outcomes
  }

  async #runSuiteSteps(
    run: FileRun,
    suite: SuiteNode,
    scope: Scope,
    errors: unknown[],
  ): Promise<Outcome[]> {
    const hooks = !scope.skipHooks && this.#suiteRunsHooks(suite)
    const teardowns: Teardown[] = []
    let outcomes: Outcome[] = []
    let ranInner = false
    const inner = async (): Promise<void> => {
      ranInner = true
      try {
        const below = hooks ? await this.#runBeforeAll(run, suite, scope, teardowns, errors) : scope
        outcomes =
          below === undefined
            ? this.#skipBelow(suite, scope.hold)
            : await this.#runChildren(run, suite, below)
      } finally {
        // A listener that ended the run ends it here too: circus has no `finally` (`run.ts` L243-L391).
        if (hooks && this.#aborted === undefined) {
          await this.#runAfterAll(run, suite, teardowns, errors)
        }
      }
    }
    const around = hooks ? suite.hooks.aroundAll : []
    if (around.length === 0) {
      await inner()
      return outcomes
    }
    const failures = await runAround(
      around.map((hook) => this.#aroundCall(run, hook, undefined)),
      inner,
      { kind: 'aroundAll', timers: this.#config.timers },
    )
    this.#rethrowAborted()
    if (failures.length > 0) {
      errors.push(...failures)
      if (!ranInner) outcomes = this.#skipBelow(suite, scope.hold)
    }
    return outcomes
  }

  /**
   * A suite's `beforeAll` hooks. Returns the scope its children run in, or `undefined` when a
   * failure skips them (`beforeAllError: 'skip-subtree'`; the failure is then the suite's).
   */
  async #runBeforeAll(
    run: FileRun,
    suite: SuiteNode,
    scope: Scope,
    teardowns: Teardown[],
    errors: unknown[],
  ): Promise<Scope | undefined> {
    const { beforeAllError, nestedHooksAfterBeforeAllError } = this.#policy.hooks
    const stop = beforeAllError === 'skip-subtree'
    const failures = await this.#runLevel(run, suite, 'beforeAll', undefined, stop, teardowns)
    if (failures.length === 0) return scope
    if (stop) {
      errors.push(...failures)
      return undefined
    }
    return {
      ...scope,
      attached: [...scope.attached, ...failures],
      skipHooks: scope.skipHooks || nestedHooksAfterBeforeAllError === 'skip',
    }
  }

  /**
   * A suite's `afterAll` hooks, then the teardowns its `beforeAll` hooks returned. Their failures
   * are the suite's or the file's (`hooks.afterAllError`).
   */
  async #runAfterAll(
    run: FileRun,
    suite: SuiteNode,
    teardowns: readonly Teardown[],
    errors: unknown[],
  ): Promise<void> {
    const failures = await this.#runAfter(run, [suite], 'afterAll', undefined, teardowns)
    if (this.#policy.hooks.afterAllError === 'fail-suite') errors.push(...failures)
    else run.file.errors.push(...failures)
  }

  /**
   * Whether a suite's own `beforeAll`/`afterAll`/`aroundAll` run. Never for a skipped suite. With
   * `skippedBlock: 'run-before-all'` (jest-circus's `hasEnabledTest`), when some test below isn't
   * skipped (a todo counts); with `'none'` (Vitest), when some test below will run, or the suite
   * is empty.
   */
  #suiteRunsHooks(suite: SuiteNode): boolean {
    if (suite.mode === 'skip') return false
    if (this.#policy.hooks.skippedBlock === 'run-before-all') return hasEnabledTest(suite)
    return runsSomething(suite)
  }

  async #runChildren(run: FileRun, suite: SuiteNode, outer: Scope): Promise<Outcome[]> {
    // jest-circus reads `jest.retryTimes` here, once the suite's `beforeAll` hooks are done.
    const fileRetry = this.#config.retryDefaults.value
    const scope: Scope = fileRetry === outer.fileRetry ? outer : { ...outer, fileRetry }
    // circus shuffles a block the first time it runs, after its `beforeAll` hooks and before the
    // concurrent tests are regrouped; a retried block keeps the order it was given.
    if (run.shuffle !== undefined && !run.shuffled.has(suite)) {
      if (suite.children.length > 0) run.shuffle(suite.children)
      run.shuffled.set(
        suite,
        suite.children.map((child) => child.id),
      )
    }
    const results: Array<Outcome | Resume> = []
    for (const group of this.#groups(suite.children)) {
      if (!group.concurrent) {
        for (const node of group.nodes) results.push(await this.#runChild(run, node, scope))
        continue
      }
      const limiter = createLimiter(this.#policy.maxConcurrency)
      const inner: Scope = { ...scope, concurrent: true }
      setRunningFrame(undefined)
      const life = this.#life
      const tests =
        life === undefined ? NO_TESTS : group.nodes.filter((node) => node.type === 'test')
      if (life !== undefined)
        await this.#tell(life, { type: 'concurrent-start', ref: suite, tests })
      const runs = group.nodes.map((node) => limiter.run(() => this.#runChild(run, node, inner)))
      // With a listener, one test's throw ends the run only once the group's others have ended,
      // so none of them reports after the file's end.
      results.push(...(await (life === undefined ? Promise.all(runs) : settleAll(runs))))
      if (life !== undefined) await this.#tell(life, { type: 'concurrent-end', ref: suite, tests })
    }
    // The retries that waited for the end of the suite (`retry.timing: 'deferred'`), in the order
    // the tests failed, one at a time, before the suite's `afterAll` hooks.
    const outcomes: Outcome[] = []
    for (const result of results)
      outcomes.push(typeof result === 'string' ? result : await result())
    return outcomes
  }

  #runChild(run: FileRun, node: SuiteNode | TestNode, scope: Scope): Promise<Outcome | Resume> {
    if (node.type !== 'test') return this.#runSuite(run, node, scope)
    return this.#tests.run(() => this.#runTest(run, node, scope))
  }

  /**
   * `concurrency.grouping`: `hoist-to-first` gathers all of a suite's concurrent tests into one
   * group at the first one's place (jest-circus); `consecutive` groups neighbours that share
   * `concurrent`, suites included (Vitest).
   */
  #groups(children: ReadonlyArray<SuiteNode | TestNode>): Group[] {
    const isConcurrent = (node: SuiteNode | TestNode): boolean =>
      node.type === 'test' ? node.concurrent : node.concurrent === true
    if (this.#policy.concurrency.grouping === 'hoist-to-first') {
      const concurrent = children.filter((node) => node.type === 'test' && node.concurrent)
      const groups: Group[] = []
      let hoisted = false
      for (const node of children) {
        if (node.type === 'test' && node.concurrent) {
          if (!hoisted) groups.push({ concurrent: true, nodes: concurrent })
          hoisted = true
        } else {
          groups.push({ concurrent: false, nodes: [node] })
        }
      }
      return groups
    }
    const groups: Array<{ concurrent: boolean; nodes: Array<SuiteNode | TestNode> }> = []
    for (const node of children) {
      const concurrent = isConcurrent(node)
      const last = groups.at(-1)
      if (last !== undefined && last.concurrent === concurrent) last.nodes.push(node)
      else groups.push({ concurrent, nodes: [node] })
    }
    return groups
  }

  /**
   * Reports every task below `suite` as skipped (a failed `beforeAll`, a blocked suite). A task
   * that is blocked itself keeps its error, as Vitest's `markTasksAsSkipped` keeps a task's result.
   */
  #skipBelow(suite: SuiteNode, hold: Hold | undefined): Outcome[] {
    const outcomes: Outcome[] = []
    for (const child of suite.children) {
      const t = this.#now()
      const errors = child.blocked === undefined ? [] : [child.blocked]
      if (child.type !== 'test') {
        this.#start(hold, 'suite-start', child.id, t)
        this.#skipBelow(child, hold)
        this.#endTask(hold, 'suite-end', child.id, 'skip', t, errors)
      } else {
        this.#start(hold, 'test-start', child.id, t)
        this.#endTask(hold, 'test-end', child.id, 'skip', t, errors, { skipReason: 'unknown' })
      }
      outcomes.push('skip')
    }
    return outcomes
  }

  // ---- tests --------------------------------------------------------------------------------

  async #runTest(run: FileRun, test: TestNode, scope: Scope): Promise<Outcome | Resume> {
    const start = this.#now()
    this.#lastTestId = test.id
    const hold = scope.hold
    this.#start(hold, 'test-start', test.id, start)
    if (test.mode === 'skip' || test.mode === 'todo') {
      const life = this.#life
      if (life !== undefined) {
        await this.#tell(life, { type: 'test-start', ref: test, id: test.id })
        await this.#tell(life, {
          type: test.mode === 'skip' ? 'test-skip' : 'test-todo',
          ref: test,
        })
      }
      const extra: ResultExtra | undefined =
        test.mode === 'skip' ? { skipReason: test.skipReason ?? 'unknown' } : undefined
      this.#endTask(hold, 'test-end', test.id, test.mode, start, [], extra)
      return test.mode
    }
    if (test.blocked !== undefined) {
      hold?.failures.push(test.blocked)
      this.#endTask(hold, 'test-end', test.id, 'fail', start, [test.blocked])
      return 'fail'
    }
    if (hold !== undefined) this.#heldTests.set(test.id, hold)
    const plan = this.#retryPlan(test, scope)
    const progress: Progress = {
      start,
      retryErrors: [],
      failures: [],
      attempts: 0,
      attemptBase: hold === undefined ? 0 : (this.#describeAttempts.get(test.id) ?? 0),
      repeatIndex: 0,
      skipped: undefined,
      parkedMs: 0,
    }
    for (let repeat = 0; repeat <= test.repeats && progress.skipped === undefined; repeat++) {
      progress.repeatIndex = repeat
      if (await this.#runAttempts(run, test, scope, plan, progress, false)) {
        // The first attempt failed and the retries wait for the end of the suite, which runs them
        // outside any concurrent group.
        const parkedAt = this.#now()
        return () =>
          this.#tests.run(() =>
            this.#resume(run, test, { ...scope, concurrent: false }, plan, progress, parkedAt),
          )
      }
    }
    if (hold !== undefined) {
      this.#describeAttempts.set(test.id, progress.attemptBase + progress.attempts)
    }
    return this.#finishTest(test, progress, hold)
  }

  /**
   * What a test is retried with, as it starts: its own `retry`, else the file's default (as its
   * suite read it), and when. Nothing at all when neither sets a retry, or when the test already
   * had errors before it ran (a `beforeAll` failure attached to it): another attempt meets the
   * same error, and Jest (`handleRetry`) skips such a test.
   */
  #retryPlan(test: TestNode, scope: Scope): RetryPlan {
    const own = test.retry
    // jest-circus gives no test its own retries inside a describe retry (`insideDescribeRetry`).
    const file = scope.hold === undefined ? scope.fileRetry : undefined
    if (scope.attached.length > 0 || (own === undefined && file === undefined)) return NO_RETRY
    const spec: RetrySpec = own ?? {
      count: retryCount(file?.count),
      delay: retryDelay(file?.delay),
      condition: undefined,
      ignoredFunction: undefined,
    }
    if (spec.count === 0) return NO_RETRY
    // Neither runner combines retries and repeats, so a repeating test keeps its retries at once.
    const timing = file?.timing ?? this.#policy.retry.timing
    return { ...spec, deferred: test.repeats === 0 && timing === 'deferred' }
  }

  /**
   * The attempts of one repeat (`progress.repeatIndex`), from the first, or, when `resuming`, from
   * the second (the first failed and the plan deferred the rest). Returns `true` when it stopped
   * after a failed attempt that the plan retries later (`deferred`), `false` when the repeat is
   * over.
   */
  async #runAttempts(
    run: FileRun,
    test: TestNode,
    scope: Scope,
    plan: RetryPlan,
    progress: Progress,
    resuming: boolean,
  ): Promise<boolean> {
    const repeat = progress.repeatIndex
    for (let attempt = resuming ? 1 : 0; attempt <= plan.count; attempt++) {
      progress.attempts++
      // The first attempt starts in the same synchronous run as the test (no turn between
      // `test-start` and here), so it carries the test's start time rather than reading the clock.
      const startedAt =
        attempt === 0 && repeat === 0 && progress.attempts === 1 ? progress.start : undefined
      const number = progress.attemptBase + attempt
      const result = await this.#runAttempt(run, test, number, repeat, scope, startedAt)
      const errors = result.errors
      // A skip that nothing failed after ends the test; a failure outranks it.
      progress.skipped = errors.length === 0 ? result.skipped : undefined
      const decision =
        errors.length > 0 && attempt < plan.count
          ? this.#retryDecision(run, test, plan, errors)
          : STOP
      this.#emit(
        {
          type: 'test-attempt-end',
          id: test.id,
          attempt: number,
          repeat,
          state: errors.length > 0 ? 'fail' : progress.skipped === undefined ? 'pass' : 'skip',
          errors: errors.map(serializeError),
          willRetry: decision.willRetry,
          t: this.#now(),
        },
        scope.hold,
      )
      if (errors.length === 0) return false
      if (!decision.willRetry) {
        progress.failures.push(...errors)
        if (decision.conditionFailure !== undefined)
          progress.failures.push(decision.conditionFailure)
        return false
      }
      if (this.#keepsEarlierErrors()) progress.retryErrors.push(...errors)
      if (plan.deferred && !resuming) return true
      await this.#announceRetry(test)
      await sleep(this.#config.timers, plan.delay)
    }
    return false
  }

  /**
   * Whether a failed attempt (its `errors`, not empty) that has retries left is retried: by the
   * plan's condition on the last error. A function that `retry.functionCondition: 'ignore-warn'`
   * leaves uncalled is no condition at all: the failure retries, with a warning.
   */
  #retryDecision(
    run: FileRun,
    test: TestNode,
    plan: RetryPlan,
    errors: readonly unknown[],
  ): RetryDecision {
    if (plan.ignoredFunction !== undefined) {
      // The runner never calls it, and calling it could turn a green suite red (D7): keep the
      // outcome, retry the failure, and say how to get what the user wrote.
      this.#warnIgnoredCondition(run, test, plan.ignoredFunction)
      return RETRY
    }
    if (plan.condition === undefined) return RETRY
    try {
      return plan.condition(serializeError(errors.at(-1))) ? RETRY : STOP
    } catch (error) {
      // A condition that throws is a failure of the test; nothing is retried on its word.
      return { willRetry: false, conditionFailure: error }
    }
  }

  /**
   * Warns, once a file, that a function `retry.condition` is not called under
   * `retry.functionCondition: 'ignore-warn'` (a D7 keep-the-outcome warning), and why
   * (`retry.functionConditionWarning`, the dialect's words). The console is the one the worker
   * captured, as the fake clock's warnings are.
   */
  #warnIgnoredCondition(run: FileRun, test: TestNode, why: string): void {
    if (run.warnedIgnoredCondition) return
    run.warnedIgnoredCondition = true
    globalThis.console.warn(
      `The function given as the retry.condition of "${test.fullName.join(this.#policy.nameSeparator)}" ` +
        `is not called: ${why}`,
    )
  }

  /** The retries of a test whose first attempt failed, once its suite has run its other tests. */
  async #resume(
    run: FileRun,
    test: TestNode,
    scope: Scope,
    plan: RetryPlan,
    progress: Progress,
    parkedAt: number,
  ): Promise<Outcome> {
    // Everything from here is the test's own time; the wait since it parked was the suite's.
    progress.parkedMs = this.#now() - parkedAt
    await this.#announceRetry(test)
    await sleep(this.#config.timers, plan.delay)
    await this.#runAttempts(run, test, scope, plan, progress, true)
    return this.#finishTest(test, progress, scope.hold)
  }

  /** Tells the lifecycle listener that a retry of `test` is about to start. */
  async #announceRetry(test: TestNode): Promise<void> {
    const life = this.#life
    if (life === undefined) return
    await this.#tell(life, {
      type: 'test-retry',
      ref: test,
      keepEarlierErrors: this.#keepsEarlierErrors(),
    })
  }

  /** Ends a test with what its attempts left, and returns its outcome. */
  #finishTest(test: TestNode, progress: Progress, hold: Hold | undefined): Outcome {
    const { start, failures, retryErrors, repeatIndex, skipped, parkedMs } = progress
    const attempts = progress.attemptBase + progress.attempts
    if (skipped !== undefined && failures.length === 0) {
      this.#endTask(hold, 'test-end', test.id, 'skip', start, [], {
        skipReason: 'dynamic',
        ...(skipped.note === undefined ? {} : { note: skipped.note }),
        attempts,
        repeatIndex,
        parkedMs,
      })
      return 'skip'
    }
    const outcome: Outcome = failures.length > 0 ? 'fail' : 'pass'
    hold?.failures.push(...failures)
    this.#endTask(hold, 'test-end', test.id, outcome, start, failures, {
      retryErrors,
      attempts,
      repeatIndex,
      parkedMs,
    })
    return outcome
  }

  /**
   * Whether the errors of an attempt that is retried stay on the test's result: what the file's
   * default says when it says (read now, as jest-circus reads `logErrorsBeforeRetry` on
   * `test_retry`), else the policy's.
   */
  #keepsEarlierErrors(): boolean {
    return (
      this.#config.retryDefaults.value?.keepEarlierErrors ?? this.#policy.retry.keepEarlierErrors
    )
  }

  async #runAttempt(
    run: FileRun,
    test: TestNode,
    attempt: number,
    repeat: number,
    scope: Scope,
    startedAt: number | undefined,
  ): Promise<{ readonly errors: unknown[]; readonly skipped: AttemptState['skipped'] }> {
    // Set by `finalize` for every node of a collected file.
    const task = test.task as TestTask
    const controller = new AbortController()
    const teardowns: Array<() => unknown> = []
    // The handle and the context read the attempt through getters, so they can be part of it.
    const handle = new RunHandle(
      test.parent.handle,
      {
        name: test.name,
        fullName: test.fullName.join(this.#policy.nameSeparator),
        file: run.file.relativePath,
        retry: attempt,
        repeat,
      },
      controller.signal,
      teardowns,
    )
    const frame: Frame = { test: task, hook: null, fileId: run.fileId, attempt, repeat }
    const state: AttemptState = {
      test,
      ctx: undefined,
      // A row of a table is called plain, as jest-each's `() => test(...params)` does (its frame
      // has no type name: `at toBe (x.test.ts:3:5)`, `cli/failure-frames`).
      thisArg:
        this.#policy.firstArg === 'context' || test.rowArgs !== undefined
          ? undefined
          : Object.create(null),
      run: handle,
      lazy: { kind: 'test', run: handle, suite: test.parent.handle, file: run.file.handle },
      frame,
      state: 'running',
      controller,
      errors: [],
      onFinished: [],
      onFailed: [],
      teardowns,
      inCallbacks: false,
      skipped: undefined,
      deadline: undefined,
      invokeEnv: undefined,
    }
    handle.attempt = state
    this.#running.set(test.id, state)
    const store = newStore({ frame, lazy: state.lazy, attempt: state })
    const t = startedAt ?? this.#now()
    this.#emit({ type: 'test-attempt-start', id: test.id, attempt, repeat, t }, scope.hold)
    setRunningFrame(scope.concurrent ? undefined : frame)
    try {
      await runInStore(store, () => this.#attemptBody(run, test, state, store, scope))
    } finally {
      state.state = 'done'
      this.#running.delete(test.id)
      setRunningFrame(undefined)
    }
    return { errors: state.errors, skipped: state.skipped }
  }

  /** The attempt, in its store: the around chain, or the attempt's steps on their own. */
  async #attemptBody(
    run: FileRun,
    test: TestNode,
    attempt: AttemptState,
    store: Store,
    scope: Scope,
  ): Promise<void> {
    const policy = this.#policy
    const errors = attempt.errors
    const life = this.#life
    if (life !== undefined) {
      await this.#tell(life, { type: 'test-start', ref: test, id: test.id })
      await this.#tell(life, { type: 'test-started', ref: test })
    }
    const eachHooks =
      !scope.skipHooks && (policy.eachHooksForConcurrent || !test.concurrent)
        ? this.#eachHooksOf(test.parent)
        : NO_EACH_HOOKS
    attempt.deadline = this.#attemptDeadline(test)
    if (eachHooks.aroundEach.length === 0) {
      await this.#attemptSteps(run, test, attempt, eachHooks, scope)
    } else {
      const inner = (): Promise<void> => this.#attemptSteps(run, test, attempt, eachHooks, scope)
      errors.push(
        ...(await runAround(
          eachHooks.aroundEach.map((hook) => this.#aroundCall(run, hook, attempt)),
          () => runInStore(store, inner),
          {
            kind: 'aroundEach',
            timers: this.#config.timers,
            onTimeout: (error) => attempt.controller.abort(error),
          },
        )),
      )
      this.#rethrowAborted()
    }
    // What the around hooks added, and whatever the steps never reached (a hook that threw first).
    attempt.state = 'cleanup'
    if (attempt.teardowns.length > 0) errors.push(...(await this.#runLazyTeardowns(attempt, 0)))
    if (test.expectFail && policy.status.expectFail === 'attempt') reverseExpectFail(errors, test)
  }

  /** The attempt inside its around hooks: each-hooks and body, teardowns, then the callbacks. */
  async #attemptSteps(
    run: FileRun,
    test: TestNode,
    attempt: AttemptState,
    eachHooks: EachHooks,
    scope: Scope,
  ): Promise<void> {
    const errors = attempt.errors
    // `LazyHost` teardowns added before this point came from the around hooks: they run after
    // them (Vitest's fixture checkpoint).
    const checkpoint = attempt.teardowns.length
    errors.push(...scope.attached)
    await this.#tryTask('before', test, attempt)
    const teardowns: Teardown[] = []
    if (errors.length === 0 && eachHooks.beforeEach.length > 0) {
      await this.#runBeforeEach(run, eachHooks.beforeEach, attempt, teardowns)
    }
    const life = this.#life
    if (life !== undefined) await this.#tell(life, { type: 'fn-start', ref: test })
    if (errors.length === 0 && attempt.skipped === undefined) await this.#runBody(test, attempt)
    if (eachHooks.afterEach.length > 0 || teardowns.length > 0) {
      // Each level's `afterEach` hooks, innermost first, then the teardowns `beforeEach` returned.
      errors.push(
        ...(await this.#runAfter(run, eachHooks.afterEach, 'afterEach', attempt, teardowns)),
      )
    }
    attempt.state = 'cleanup'
    if (attempt.teardowns.length > checkpoint) {
      errors.push(...(await this.#runLazyTeardowns(attempt, checkpoint)))
    }
    errors.push(...this.#config.processErrors.take(attempt.frame))
    await this.#tryTask('after', test, attempt)
    attempt.inCallbacks = true
    if (attempt.onFinished.length > 0) {
      await this.#runCallbacks(run, attempt, attempt.onFinished.toReversed(), 'onTestFinished')
    }
    if (errors.length > 0) {
      const failed = this.#order(attempt.onFailed, 'afterEach')
      if (failed.length > 0) await this.#runCallbacks(run, attempt, failed, 'onTestFailed')
    }
    if (life !== undefined) await this.#tell(life, { type: 'test-done', ref: test, errors })
  }

  /**
   * Calls the listeners registered for the start (`before`, ahead of the first `beforeEach`) or the
   * end (`after`, behind the last `afterEach` and the teardowns, ahead of `onTestFinished`) of an
   * attempt, in the attempt's store. A listener that throws fails the attempt.
   */
  async #tryTask(kind: 'before' | 'after', test: TestNode, attempt: AttemptState): Promise<void> {
    const listeners = this.#config.tryTask[kind]
    if (listeners.length === 0) return
    const info = new TryInfo(
      test.task as TestTask,
      attempt,
      kind === 'after' && attempt.errors.length > 0,
      this.#contextFor,
    )
    for (const listener of [...listeners]) {
      try {
        await listener(info)
      } catch (error) {
        attempt.errors.push(error)
      }
    }
  }

  /** The `EachHooks` of a test in `suite`. Hooks never change once a file is collected. */
  #eachHooksOf(suite: SuiteNode): EachHooks {
    let found = this.#eachHooks.get(suite)
    if (found === undefined) {
      const chain = suiteChain(suite)
      found = {
        beforeEach: chain.filter((level) => level.hooks.beforeEach.length > 0),
        afterEach: chain.toReversed().filter((level) => level.hooks.afterEach.length > 0),
        aroundEach: chain.flatMap((level) => level.hooks.aroundEach),
      }
      this.#eachHooks.set(suite, found)
    }
    return found
  }

  /** A test's timeout: its own, else the file's default (`setDefaultTimeout`), else the policy's. */
  #testTimeout(test: TestNode): number {
    return test.timeoutMs ?? this.#config.defaults.ms ?? this.#policy.timeouts.test
  }

  /** A hook's timeout when it names none: the file's default, else the policy's. */
  #hookTimeout(): number {
    return this.#config.defaults.ms ?? this.#policy.timeouts.hook
  }

  /**
   * With `hooks.timeoutCountsTestTimeout`, when the attempt's each-hooks and body must be done
   * (`Infinity` for a test with no timeout); otherwise `undefined`, each call having its own.
   */
  #attemptDeadline(test: TestNode): number | undefined {
    if (!this.#policy.hooks.timeoutCountsTestTimeout) return undefined
    const timeoutMs = this.#testTimeout(test)
    return isBounded(timeoutMs) ? this.#now() + timeoutMs : Number.POSITIVE_INFINITY
  }

  /**
   * The bound on an each-hook or the body: what is left of the attempt's deadline (at least 1 ms,
   * so a spent one still times out), or the call's own timeout when the attempt has none.
   */
  #timeoutFor(attempt: AttemptState | undefined, ownMs: number): number {
    const deadline = attempt?.deadline
    return deadline === undefined ? ownMs : Math.max(1, deadline - this.#now())
  }

  /** Each level's `beforeEach` hooks, parent first; the first level that fails ends them. */
  async #runBeforeEach(
    run: FileRun,
    levels: readonly SuiteNode[],
    attempt: AttemptState,
    teardowns: Teardown[],
  ): Promise<void> {
    for (const suite of levels) {
      const failures = await this.#runLevel(run, suite, 'beforeEach', attempt, true, teardowns)
      if (failures.length > 0) {
        attempt.errors.push(...failures)
        return
      }
      if (attempt.skipped !== undefined) return
    }
  }

  /**
   * The body. A test that runs with no function fails. Under `status.expectFail: 'body'` a
   * `.failing` test's result is reversed here (jest-circus), so a hook error still fails it.
   */
  async #runBody(test: TestNode, attempt: AttemptState): Promise<void> {
    const life = this.#life
    if (test.fn === undefined) {
      const missing = new CoreError('CORE_MISSING_TEST_FN', 'Test function is not found')
      attempt.errors.push(missing)
      if (life !== undefined) await this.#bodyEnd(life, test, attempt, [missing], true)
      return
    }
    const { fn } = test
    const policy = this.#policy
    const contextArgs =
      test.passContext && (test.rowArgs !== undefined || policy.firstArg === 'context')
        ? [this.#contextOf(attempt)]
        : NO_ARGS
    // Taken before the limiter: time spent waiting for a slot counts against the attempt.
    const ownMs = this.#testTimeout(test)
    const timeoutMs = this.#timeoutFor(attempt, ownMs)
    const failures: unknown[] = []
    let threw = false
    try {
      await this.#calls.run(() =>
        this.#deadlines.call(
          () =>
            invoke(this.#invokeEnv(attempt), {
              fn,
              arity: test.arity,
              thisArg: attempt.thisArg,
              args: test.rowArgs ?? NO_ARGS,
              contextArgs,
              isTest: true,
            }),
          { what: 'test', timeoutMs, namedMs: ownMs, attempt },
        ),
      )
    } catch (error) {
      // `ctx.skip()` ends the test as skipped, not failed.
      if (error instanceof SkipSignal) attempt.skipped = { note: error.note }
      else {
        threw = true
        failures.push(error)
      }
    }
    if (test.expectFail && policy.status.expectFail === 'body') reverseExpectFail(failures, test)
    attempt.errors.push(...failures)
    // A rejection nobody handled by now is the test's own (jest-circus `test_fn_success`).
    attempt.errors.push(...this.#config.processErrors.take(attempt.frame))
    if (life !== undefined) await this.#bodyEnd(life, test, attempt, failures, threw)
  }

  /**
   * `fn-end`. For a body that returned, the listener's throw is taken as the body's own (circus
   * dispatches inside the `try`, `run.ts` L497-L519): the reversal of an expected failure applies to
   * it, what it leaves is the attempt's failure, and the listener hears `fn-end` again. For a body
   * that threw, the dispatch sits in the `catch`, so a throw ends the run.
   */
  async #bodyEnd(
    life: LifecycleListener,
    test: TestNode,
    attempt: AttemptState,
    failures: readonly unknown[],
    threw: boolean,
  ): Promise<void> {
    const event: LifecycleEvent = {
      type: 'fn-end',
      ref: test,
      failed: failures.length > 0,
      error: failures[0],
    }
    if (threw) return this.#tell(life, event)
    const thrown = await this.#tellInside(life, event)
    if (thrown === undefined) return
    const again: unknown[] = [thrown.error]
    if (test.expectFail && this.#policy.status.expectFail === 'body') reverseExpectFail(again, test)
    attempt.errors.push(...again)
    await this.#tell(life, { type: 'fn-end', ref: test, failed: again.length > 0, error: again[0] })
  }

  /**
   * An attempt's test context, built on its first read and recorded then for `LazyHost.runOf`:
   * under a policy that hands it to no hook or body (Jest's), an attempt nobody asks about never
   * builds one (T5.14). Every reader goes through here, so a context that exists is recorded.
   */
  #contextOf(attempt: AttemptState): TestContext {
    const existing = attempt.ctx
    if (existing !== undefined) return existing
    const created = createTestContext(attempt, this.#contextEnv)
    this.#config.runs.set(created, attempt.run)
    attempt.ctx = created
    return created
  }

  /**
   * What a user call needs besides the policy: the printer, and what a late `done` does. One per
   * attempt (and one for every call outside a test), built on its first call, not one per call.
   */
  #invokeEnv(attempt: AttemptState | undefined): InvokeEnv {
    if (attempt === undefined) return this.#outsideTestEnv
    let env = attempt.invokeEnv
    if (env === undefined) {
      env = {
        policy: this.#policy,
        format: this.#config.formatValue,
        over: () => attempt.state !== 'running',
        late: this.#lateDone,
      }
      attempt.invokeEnv = env
    }
    return env
  }

  /** Runs the attempt's `LazyHost` teardowns down to `keep`, last added first. */
  #runLazyTeardowns(attempt: AttemptState, keep: number): Promise<unknown[]> {
    return this.#deadlines.drain(attempt.teardowns, { keep, attempt })
  }

  // ---- hooks --------------------------------------------------------------------------------

  /**
   * Runs one suite's hooks of one kind, in `hookOrder`. `stop`: the first failure ends the level
   * (sequential orders only). `teardowns` collects returned functions (`hookReturnsCleanup`).
   */
  #runLevel(
    run: FileRun,
    suite: SuiteNode,
    kind: HookKind,
    attempt: AttemptState | undefined,
    stop: boolean,
    teardowns?: Teardown[],
  ): Promise<unknown[]> {
    const keep = this.#policy.hookReturnsCleanup ? teardowns : undefined
    return this.#runOrdered(
      suite.hooks[kind],
      kind,
      stop,
      (hook) => this.#callHook(run, hook, attempt),
      keep === undefined
        ? undefined
        : (hook, value) => {
            if (typeof value === 'function') {
              keep.push({ fn: value as UserFn, owner: suite, ordinal: hook.ordinal })
            }
          },
      // A skip in a `beforeEach` ends the chain, as a failure does.
      kind === 'beforeEach' && attempt !== undefined
        ? () => attempt.skipped !== undefined
        : undefined,
    )
  }

  /**
   * `kind`'s hooks level by level, then the teardowns the matching before hooks returned. Under
   * `afterError: 'abort-chain'` a level that fails ends it there.
   */
  async #runAfter(
    run: FileRun,
    levels: readonly SuiteNode[],
    kind: 'afterEach' | 'afterAll',
    attempt: AttemptState | undefined,
    teardowns: readonly Teardown[],
  ): Promise<unknown[]> {
    const abort = this.#policy.hooks.afterError === 'abort-chain'
    const failures: unknown[] = []
    for (const suite of levels) {
      const level = await this.#runLevel(run, suite, kind, attempt, abort)
      failures.push(...level)
      if (abort && level.length > 0) return failures
    }
    if (teardowns.length > 0) {
      failures.push(...(await this.#runTeardowns(run, teardowns, kind, attempt)))
    }
    return failures
  }

  /**
   * Calls `items` in the order of `kind`'s hooks (`orderHooks`, else `hookOrder`; all at once
   * when parallel), returning their failures. `stop`: the first failure ends a sequential run.
   * `onValue` sees what each successful call returned.
   */
  async #runOrdered<T>(
    items: readonly T[],
    kind: HookKind,
    stop: boolean,
    call: (item: T) => Promise<CallResult>,
    onValue?: (item: T, value: unknown) => void,
    halted?: () => boolean,
  ): Promise<unknown[]> {
    const failures: unknown[] = []
    if (items.length === 0) return failures
    if (this.#parallel(kind)) {
      await Promise.all(
        items.map(async (item) => {
          const result = await call(item)
          if (result.ok) onValue?.(item, result.value)
          else failures.push(result.error)
        }),
      )
      return failures
    }
    // In sequence, each call is awaited here: no async wrapper per call (T5.14).
    for (const item of this.#order(items, kind)) {
      const result = await call(item)
      if (result.ok) onValue?.(item, result.value)
      else failures.push(result.error)
      if ((stop && failures.length > 0) || halted?.() === true) break
    }
    return failures
  }

  /**
   * Calls a declared hook. An each-hook (one called with an attempt) gets the test's context and
   * innermost suite, shares the attempt's `this` with the body, and is bounded by what is left of
   * the attempt's deadline when it has one; a suite hook gets its own suite and a fresh `this`.
   */
  #callHook(run: FileRun, hook: HookNode, attempt: AttemptState | undefined): Promise<CallResult> {
    const policy = this.#policy
    const byContext = policy.firstArg === 'context'
    const contextArgs = !byContext
      ? NO_ARGS
      : attempt !== undefined
        ? [this.#contextOf(attempt), taskOf(attempt.test.parent)]
        : [taskOf(hook.owner)]
    const thisArg = attempt !== undefined ? attempt.thisArg : byContext ? undefined : {}
    return this.#callUser(
      run,
      {
        kind: hook.kind,
        owner: hook.owner,
        ordinal: hook.ordinal,
        hook,
        location: hook.location,
        attempt,
      },
      this.#timeoutFor(attempt, hook.timeoutMs ?? this.#hookTimeout()),
      () =>
        invoke(this.#invokeEnv(attempt), {
          fn: hook.fn,
          arity: hook.arity,
          thisArg,
          args: NO_ARGS,
          contextArgs,
          isTest: false,
        }),
    )
  }

  /** Calls one hook-like user function in its own store, with events, a deadline and the limiter. */
  async #callUser(
    run: FileRun,
    spec: HookCall,
    timeoutMs: number,
    call: () => unknown,
  ): Promise<CallResult> {
    const { attempt } = spec
    const store = this.#hookScope(run, spec.kind, spec.owner, attempt)
    // Only a hook the file declared is a lifecycle hook: not a teardown, a callback or a lazy value's.
    const hook = spec.hook
    const life = hook === undefined || hook.synthetic ? undefined : this.#life
    if (life !== undefined && hook !== undefined) {
      await this.#tell(life, {
        type: 'hook-start',
        hook,
        owner: spec.owner,
        kind: hook.kind,
        test: attempt?.test,
      })
    }
    const startedAt = this.#emitHookStart(spec)
    let result: CallResult
    try {
      const calls = this.#calls
      // With no limiter the call starts at once, so `hook-start`'s time is its deadline's start
      // too; a call that may wait for a slot reads the clock again when it gets one.
      const bounded = (): Promise<unknown> =>
        this.#deadlines.call(call, {
          what: 'hook',
          timeoutMs,
          attempt,
          start: calls === unlimited ? startedAt : undefined,
        })
      const value = await (calls === unlimited
        ? runInStore(store, bounded)
        : calls.run(() => runInStore(store, bounded)))
      result = { ok: true, value }
    } catch (error) {
      // `ctx.skip()` in an each-hook ends the test as skipped.
      if (error instanceof SkipSignal && attempt !== undefined) {
        attempt.skipped = { note: error.note }
        result = PASSED
      } else {
        result = { ok: false, error }
      }
    }
    if (life !== undefined && hook !== undefined)
      result = await this.#hookEnd(life, hook, spec, result)
    this.#emitHookEnd(spec, result)
    return result
  }

  /**
   * `hook-end`. For a hook that passed, the listener's throw is the hook's failure (circus
   * dispatches `hook_success` inside the `try` and re-dispatches `hook_failure`, `run.ts`
   * L467-L481); for one that failed it ends the run.
   */
  async #hookEnd(
    life: LifecycleListener,
    hook: HookNode,
    spec: HookCall,
    result: CallResult,
  ): Promise<CallResult> {
    const ended = {
      type: 'hook-end',
      hook,
      owner: spec.owner,
      kind: hook.kind,
      test: spec.attempt?.test,
    } as const
    if (!result.ok) {
      await this.#tell(life, { ...ended, failed: true, error: result.error })
      return result
    }
    const thrown = await this.#tellInside(life, { ...ended, failed: false, error: undefined })
    if (thrown === undefined) return result
    await this.#tell(life, { ...ended, failed: true, error: thrown.error })
    return { ok: false, error: thrown.error }
  }

  /**
   * The store a hook-like call runs in: its own frame, with the attempt's lazy frame for a test's
   * hook (LazyHost guarantee 1), or a `suite` lazy frame for a suite hook.
   */
  #hookScope(
    run: FileRun,
    kind: RuntimeHookKind,
    owner: SuiteNode,
    attempt: AttemptState | undefined,
  ): Store {
    const hook = { kind, ownerId: owner.id }
    if (attempt !== undefined) {
      // The attempt's frame with this hook: every other field (test, attempt, repeat) carries over.
      const { test, fileId, attempt: index, repeat } = attempt.frame
      return newStore({
        // The attempt's frame with this hook, written out in `Frame`'s key order (a spread is
        // slower, once per hook call).
        frame: { test, hook, fileId, attempt: index, repeat },
        lazy: attempt.lazy,
        attempt,
        hook: kind,
      })
    }
    return newStore({
      frame: { test: null, hook, fileId: run.fileId, attempt: 0, repeat: 0 },
      lazy: {
        kind: 'suite',
        hook: kind === 'afterAll' || kind === 'teardown' ? 'afterAll' : 'beforeAll',
        suite: owner.handle,
        file: run.file.handle,
      },
      hook: kind,
    })
  }

  /** `hook-end`, once the call has its `result`. */
  #emitHookEnd(spec: HookCall, result: CallResult): void {
    const ownerId = spec.owner.id
    const testId = spec.attempt?.test.id ?? null
    const { kind, ordinal } = spec
    const error = result.ok ? null : serializeError(result.error)
    this.#emit({ type: 'hook-end', ownerId, testId, kind, ordinal, error, t: this.#now() })
  }

  /** `hook-start`, with the hook's location; returns the time it carries. */
  #emitHookStart(spec: HookCall): number {
    const ownerId = spec.owner.id
    const testId = spec.attempt?.test.id ?? null
    const { kind, ordinal, location } = spec
    const t = this.#now()
    this.#emit({ type: 'hook-start', ownerId, testId, kind, ordinal, location, t })
    return t
  }

  /** Runs the teardowns hooks returned, in the order of `hookOrder[after]`. */
  #runTeardowns(
    run: FileRun,
    teardowns: readonly Teardown[],
    after: 'afterEach' | 'afterAll',
    attempt: AttemptState | undefined,
  ): Promise<unknown[]> {
    const stop = this.#policy.hooks.afterError === 'abort-chain'
    return this.#runOrdered(teardowns, after, stop, (teardown) =>
      this.#callUser(
        run,
        {
          kind: 'teardown',
          owner: teardown.owner,
          ordinal: teardown.ordinal,
          hook: undefined,
          location: null,
          attempt,
        },
        this.#policy.timeouts.teardown,
        () => Reflect.apply(teardown.fn, undefined, []),
      ),
    )
  }

  /**
   * Runs `onTestFinished`/`onTestFailed` callbacks in the given order, adding their failures to
   * the attempt's. A callback's timeout is the hook default when none is given (or `0` reads as
   * the default).
   */
  async #runCallbacks(
    run: FileRun,
    attempt: AttemptState,
    callbacks: readonly TestCallback[],
    kind: 'onTestFinished' | 'onTestFailed',
  ): Promise<void> {
    const { timeouts } = this.#policy
    for (const [ordinal, callback] of callbacks.entries()) {
      const result = await this.#callUser(
        run,
        { kind, owner: attempt.test.parent, ordinal, hook: undefined, location: null, attempt },
        resolveTimeout(timeouts, callback.timeoutMs) ?? this.#hookTimeout(),
        () => Reflect.apply(callback.fn, undefined, [this.#contextOf(attempt)]),
      )
      if (!result.ok) attempt.errors.push(result.error)
    }
  }

  #aroundCall(run: FileRun, hook: HookNode, attempt: AttemptState | undefined): AroundCall {
    const spec: HookCall = {
      kind: hook.kind,
      owner: hook.owner,
      ordinal: hook.ordinal,
      hook,
      location: hook.location,
      attempt,
    }
    const store = this.#hookScope(run, hook.kind, hook.owner, attempt)
    return {
      timeoutMs: hook.timeoutMs ?? this.#hookTimeout(),
      invoke: async (inner) => {
        this.#emitHookStart(spec)
        try {
          const args =
            attempt === undefined
              ? [inner, taskOf(hook.owner)]
              : [inner, this.#contextOf(attempt), taskOf(attempt.test.parent)]
          await runInStore(store, () => Reflect.apply(hook.fn, undefined, args))
          this.#emitHookEnd(spec, PASSED)
        } catch (error) {
          this.#emitHookEnd(spec, { ok: false, error })
          throw error
        }
      },
    }
  }

  // ---- helpers ------------------------------------------------------------------------------

  #parallel(kind: HookKind): boolean {
    return this.#config.orderHooks === undefined && this.#policy.hookOrder[kind] === 'parallel'
  }

  /** The items of one hook kind in run order (`orderHooks` wins over `hookOrder`). */
  #order<T>(items: readonly T[], kind: HookKind): readonly T[] {
    if (this.#config.orderHooks !== undefined) return this.#config.orderHooks(items, kind)
    return this.#policy.hookOrder[kind] === 'reverse' ? items.toReversed() : items
  }

  #now(): number {
    return this.#config.now()
  }

  /** Emits an event, or holds it with the describe attempt it belongs to until that is decided. */
  #emit(event: RuntimeEvent, hold?: Hold): void {
    if (hold === undefined) this.#config.sink.emit(event)
    else hold.events.push(event)
  }

  /**
   * Emits a task's start, at once even inside a describe attempt. An attempt after the first runs
   * tasks that have started already: their start is not reported again.
   */
  #start(hold: Hold | undefined, type: 'test-start' | 'suite-start', id: TaskId, t: number): void {
    if (hold !== undefined) {
      if (hold.started.has(id)) return
      hold.started.add(id)
    }
    this.#config.sink.emit({ type, id, t })
  }

  /**
   * Emits an error `ProcessErrors` charged to the run, a file or an ended test. One charged to a
   * test whose describe attempt is still open waits with that attempt's events and is one of its
   * failures, as circus pushes it to `test.errors` (`eventHandler.ts` L308); an attempt already
   * closed hands it to the one it ran in.
   */
  emitCharged(event: RuntimeEvent): void {
    if (event.type === 'unhandled-error' && event.ownerId !== null && this.#heldTests.size > 0) {
      let hold = this.#heldTests.get(event.ownerId)
      while (hold !== undefined && !hold.open) hold = hold.parent
      if (hold !== undefined) {
        hold.failures.push(event)
        hold.events.push(event)
        return
      }
    }
    this.#config.sink.emit(event)
  }

  /** Emits a task's end event, its result and the event timed now. */
  #endTask(
    hold: Hold | undefined,
    type: 'test-end' | 'suite-end',
    id: TaskId,
    state: TaskState,
    start: number,
    errors: readonly unknown[],
    extra?: ResultExtra,
  ): void {
    const t = this.#now()
    this.#emit({ type, id, result: taskResult(state, start, t, errors, extra), t }, hold)
  }
}

/** An error as a result carries it. */
type SerializedError = TaskResult['errors'][number]

/**
 * An end event with the errors of the describe attempts dropped before it added to its test's
 * `retryErrors`, in order.
 */
function withDropped(
  event: RuntimeEvent,
  dropped: ReadonlyMap<TaskId, SerializedError[]>,
): RuntimeEvent {
  if (event.type !== 'test-end') return event
  const earlier = dropped.get(event.id)
  if (earlier === undefined) return event
  return {
    ...event,
    result: { ...event.result, retryErrors: [...earlier, ...event.result.retryErrors] },
  }
}

/** A result's optional parts; each defaults to none. */
export interface ResultExtra {
  readonly skipReason?: SkipReason
  readonly note?: string
  readonly retryErrors?: readonly unknown[]
  readonly attempts?: number
  readonly repeatIndex?: number
  /**
   * Milliseconds between the task's start and end that were not its own: a retry that waited for
   * the end of its suite (`retry.timing: 'deferred'`) was parked while the suite's other tests ran.
   */
  readonly parkedMs?: number
  /** The order a suite's children ran in, when the run shuffled them. */
  readonly childOrder?: readonly TaskId[]
}

/** A task's (or a file's) result, its errors serialized. */
export function taskResult(
  state: TaskState,
  start: number,
  end: number,
  errors: readonly unknown[],
  extra: ResultExtra = {},
): TaskResult {
  return {
    state,
    durationMs: end - start - (extra.parkedMs ?? 0),
    startTime: start,
    errors: errors.map(serializeError),
    retryErrors: (extra.retryErrors ?? []).map(serializeError),
    attempts: extra.attempts ?? 0,
    repeatIndex: extra.repeatIndex ?? 0,
    assertions: 0,
    passingAssertions: 0,
    ...(extra.skipReason === undefined ? {} : { skipReason: extra.skipReason }),
    ...(extra.note === undefined ? {} : { note: extra.note }),
    ...(extra.childOrder === undefined ? {} : { childOrder: extra.childOrder }),
  }
}

/**
 * One attempt's `TestRunHandle`. A class, so every handle shares one `state` getter: a literal with
 * an accessor gives each attempt a map of its own, which cost about 0.3 µs per attempt (T5.14).
 * `addTeardown` stays an own function, callable detached, as the literal's method was.
 */
class RunHandle implements TestRunHandle {
  readonly test: { readonly suite: SuiteHandle }
  readonly ctx: { readonly task: TaskInfo }
  readonly slots: Map<symbol, unknown> = new Map()
  readonly signal: AbortSignal
  readonly addTeardown: (fn: () => unknown) => void
  /** The attempt this handle reports on; set once the attempt holding the handle exists. */
  attempt: AttemptState | undefined = undefined

  constructor(
    suite: SuiteHandle,
    task: TaskInfo,
    signal: AbortSignal,
    teardowns: Array<() => unknown>,
  ) {
    this.test = { suite }
    this.ctx = { task }
    this.signal = signal
    this.addTeardown = (fn) => {
      teardowns.push(fn)
    }
  }

  get state(): 'running' | 'cleanup' | 'done' {
    return this.attempt?.state ?? 'running'
  }
}

/**
 * What `onBeforeTryTask`/`onAfterTryTask` listeners get. A class, so `ctx` can be a getter shared
 * by every instance: the context is built only if a listener reads it. `fail` stays an own
 * function, callable detached (the worker destructures it), as the literal's was.
 */
class TryInfo implements TryTaskInfo {
  readonly test: TestTask
  readonly attempt: number
  readonly repeat: number
  readonly failed: boolean
  readonly fail: (error: unknown) => void
  readonly #state: AttemptState
  readonly #contextOf: (attempt: AttemptState) => TestContext

  constructor(
    test: TestTask,
    state: AttemptState,
    failed: boolean,
    contextOf: (attempt: AttemptState) => TestContext,
  ) {
    this.test = test
    this.attempt = state.frame.attempt
    this.repeat = state.frame.repeat
    this.failed = failed
    this.#state = state
    this.#contextOf = contextOf
    this.fail = (error) => void state.errors.push(error)
  }

  get ctx(): TestContext {
    return this.#contextOf(this.#state)
  }
}

/** A suite's outcome, from its own errors and its children's outcomes. */
function suiteOutcome(
  suite: SuiteNode,
  errors: readonly unknown[],
  children: readonly Outcome[],
): Outcome {
  if (errors.length > 0 || children.includes('fail')) return 'fail'
  if (children.includes('pass') || children.length === 0) {
    return suite.mode === 'skip' ? 'skip' : 'pass'
  }
  return suite.mode === 'todo' ? 'todo' : 'skip'
}

/** A suite's clone-safe task (the `FileTask` for the root), set by `finalize`. */
function taskOf(suite: SuiteNode): SuiteTask | FileTask {
  return suite.task as SuiteTask | FileTask
}

function expectedFailure(test: TestNode): CoreError {
  const message =
    'Failing test passed even though it was supposed to fail. Remove `.failing` to remove error.'
  const error = new CoreError('CORE_EXPECTED_FAILURE', message)
  // jest-circus reports it at the test's definition (`test.asyncError`, whose message it sets): the
  // text is the message, then the frames of the call that registered the test, never ours.
  const frames = test.site?.stack?.split('\n').slice(1).join('\n')
  if (frames !== undefined && frames !== '') error.stack = `${message}\n${frames}`
  return error
}

/**
 * A `.failing`/`.fails` result reversed in place: errors are dropped (the expected failure), and
 * none becomes `CORE_EXPECTED_FAILURE`. `status.expectFail` picks whether it applies to the body
 * (jest-circus) or the whole attempt (Vitest's `fails`).
 */
/**
 * Every task's result once all have settled; the first rejection, if any, is then thrown. Used for
 * a concurrent group under a listener, whose throw at one test ends the run (`#tell`).
 */
async function settleAll<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks)
  const values: T[] = []
  for (const entry of settled) {
    if (entry.status === 'rejected') throw entry.reason
    values.push(entry.value)
  }
  return values
}

function reverseExpectFail(errors: unknown[], test: TestNode): void {
  if (errors.length > 0) errors.length = 0
  else errors.push(expectedFailure(test))
}

/** The suites from the file root down to `suite`. */
function suiteChain(suite: SuiteNode): SuiteNode[] {
  const chain: SuiteNode[] = []
  for (let node: SuiteNode | null = suite; node !== null; node = node.parent) chain.unshift(node)
  return chain
}

/** jest-circus's `hasEnabledTest`: some test below isn't skipped. */
function hasEnabledTest(suite: SuiteNode): boolean {
  return suite.children.some((child) =>
    child.type !== 'test' ? hasEnabledTest(child) : child.mode !== 'skip',
  )
}

/** Vitest's suite collapse: the suite is empty, or something below it will run. */
function runsSomething(suite: SuiteNode): boolean {
  if (suite.children.length === 0) return true
  return suite.children.some((child) =>
    child.type !== 'test' ? child.mode !== 'skip' && runsSomething(child) : child.mode === 'run',
  )
}
