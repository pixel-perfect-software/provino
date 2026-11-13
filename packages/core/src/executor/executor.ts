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
  EventSink,
  FileTask,
  FormatValue,
  Frame,
  HookKind,
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

/** What a test's attempts have left so far. */
interface Progress {
  readonly start: number
  /** The errors of the attempts that were retried, when the result keeps them. */
  readonly retryErrors: unknown[]
  /** The errors of the attempt that ended the test. */
  readonly failures: unknown[]
  attempts: number
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
  /** The test that started last. */
  #lastTestId: TaskId | null = null
  /** The path of the file running now, for the location of a `ctx.annotate` call. */
  #filePath: string | undefined

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
  async runFile(file: FileState): Promise<Outcome> {
    const run: FileRun = { file, fileId: file.root.id, warnedIgnoredCondition: false }
    this.#filePath = file.path
    return this.#runSuite(run, file.root, {
      attached: [],
      skipHooks: false,
      concurrent: false,
      fileRetry: undefined,
    })
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
    if (!isRoot) this.#emit({ type: 'suite-start', id: suite.id, t: start })
    const errors: unknown[] = []
    let children: Outcome[] = []
    if (suite.blocked !== undefined) {
      errors.push(suite.blocked)
      this.#skipBelow(suite)
    } else {
      children = await this.#runSuiteBody(run, suite, scope, errors)
    }
    if (suite.emptyError !== undefined && suite.mode === 'run') errors.push(suite.emptyError)
    const outcome = suiteOutcome(suite, errors, children)
    if (isRoot) run.file.errors.push(...errors)
    else this.#endTask('suite-end', suite.id, outcome, start, errors)
    return outcome
  }

  async #runSuiteBody(
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
          below === undefined ? this.#skipBelow(suite) : await this.#runChildren(run, suite, below)
      } finally {
        if (hooks) await this.#runAfterAll(run, suite, teardowns, errors)
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
    if (failures.length > 0) {
      errors.push(...failures)
      if (!ranInner) outcomes = this.#skipBelow(suite)
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
    const results: Array<Outcome | Resume> = []
    for (const group of this.#groups(suite.children)) {
      if (!group.concurrent) {
        for (const node of group.nodes) results.push(await this.#runChild(run, node, scope))
        continue
      }
      const limiter = createLimiter(this.#policy.maxConcurrency)
      const inner: Scope = { ...scope, concurrent: true }
      setRunningFrame(undefined)
      results.push(
        ...(await Promise.all(
          group.nodes.map((node) => limiter.run(() => this.#runChild(run, node, inner))),
        )),
      )
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
  #skipBelow(suite: SuiteNode): Outcome[] {
    const outcomes: Outcome[] = []
    for (const child of suite.children) {
      const t = this.#now()
      const errors = child.blocked === undefined ? [] : [child.blocked]
      if (child.type !== 'test') {
        this.#emit({ type: 'suite-start', id: child.id, t })
        this.#skipBelow(child)
        this.#endTask('suite-end', child.id, 'skip', t, errors)
      } else {
        this.#emit({ type: 'test-start', id: child.id, t })
        this.#endTask('test-end', child.id, 'skip', t, errors, { skipReason: 'unknown' })
      }
      outcomes.push('skip')
    }
    return outcomes
  }

  // ---- tests --------------------------------------------------------------------------------

  async #runTest(run: FileRun, test: TestNode, scope: Scope): Promise<Outcome | Resume> {
    const start = this.#now()
    this.#lastTestId = test.id
    this.#emit({ type: 'test-start', id: test.id, t: start })
    if (test.mode === 'skip' || test.mode === 'todo') {
      const extra: ResultExtra | undefined =
        test.mode === 'skip' ? { skipReason: test.skipReason ?? 'unknown' } : undefined
      this.#endTask('test-end', test.id, test.mode, start, [], extra)
      return test.mode
    }
    if (test.blocked !== undefined) {
      this.#endTask('test-end', test.id, 'fail', start, [test.blocked])
      return 'fail'
    }
    const plan = this.#retryPlan(test, scope)
    const progress: Progress = {
      start,
      retryErrors: [],
      failures: [],
      attempts: 0,
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
    return this.#finishTest(test, progress)
  }

  /**
   * What a test is retried with, as it starts: its own `retry`, else the file's default (as its
   * suite read it), and when. Nothing at all when neither sets a retry, or when the test already
   * had errors before it ran (a `beforeAll` failure attached to it): another attempt meets the
   * same error, and Jest (`handleRetry`) skips such a test.
   */
  #retryPlan(test: TestNode, scope: Scope): RetryPlan {
    const own = test.retry
    const file = scope.fileRetry
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
      const result = await this.#runAttempt(run, test, attempt, repeat, scope, startedAt)
      const errors = result.errors
      // A skip that nothing failed after ends the test; a failure outranks it.
      progress.skipped = errors.length === 0 ? result.skipped : undefined
      const decision =
        errors.length > 0 && attempt < plan.count
          ? this.#retryDecision(run, test, plan, errors)
          : STOP
      this.#emit({
        type: 'test-attempt-end',
        id: test.id,
        attempt,
        repeat,
        state: errors.length > 0 ? 'fail' : progress.skipped === undefined ? 'pass' : 'skip',
        errors: errors.map(serializeError),
        willRetry: decision.willRetry,
        t: this.#now(),
      })
      if (errors.length === 0) return false
      if (!decision.willRetry) {
        progress.failures.push(...errors)
        if (decision.conditionFailure !== undefined)
          progress.failures.push(decision.conditionFailure)
        return false
      }
      if (this.#keepsEarlierErrors()) progress.retryErrors.push(...errors)
      if (plan.deferred && !resuming) return true
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
    await sleep(this.#config.timers, plan.delay)
    await this.#runAttempts(run, test, scope, plan, progress, true)
    return this.#finishTest(test, progress)
  }

  /** Ends a test with what its attempts left, and returns its outcome. */
  #finishTest(test: TestNode, progress: Progress): Outcome {
    const { start, failures, retryErrors, attempts, repeatIndex, skipped, parkedMs } = progress
    if (skipped !== undefined && failures.length === 0) {
      this.#endTask('test-end', test.id, 'skip', start, [], {
        skipReason: 'dynamic',
        ...(skipped.note === undefined ? {} : { note: skipped.note }),
        attempts,
        repeatIndex,
        parkedMs,
      })
      return 'skip'
    }
    const outcome: Outcome = failures.length > 0 ? 'fail' : 'pass'
    this.#endTask('test-end', test.id, outcome, start, failures, {
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
      thisArg: this.#policy.firstArg === 'context' ? undefined : Object.create(null),
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
    this.#emit({ type: 'test-attempt-start', id: test.id, attempt, repeat, t })
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
    }
    // What the around hooks added, and whatever the steps never reached (a hook that threw first).
    attempt.state = 'cleanup'
    if (attempt.teardowns.length > 0) errors.push(...(await this.#runLazyTeardowns(attempt, 0)))
    if (test.expectFail && policy.status.expectFail === 'attempt') reverseExpectFail(errors)
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
    if (test.fn === undefined) {
      attempt.errors.push(new CoreError('CORE_MISSING_TEST_FN', 'Test function is not found'))
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
      else failures.push(error)
    }
    if (test.expectFail && policy.status.expectFail === 'body') reverseExpectFail(failures)
    attempt.errors.push(...failures)
    // A rejection nobody handled by now is the test's own (jest-circus `test_fn_success`).
    attempt.errors.push(...this.#config.processErrors.take(attempt.frame))
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
    this.#emitHookEnd(spec, result)
    return result
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
        { kind, owner: attempt.test.parent, ordinal, location: null, attempt },
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

  #emit(event: RuntimeEvent): void {
    this.#config.sink.emit(event)
  }

  /** Emits a task's end event, its result and the event timed now. */
  #endTask(
    type: 'test-end' | 'suite-end',
    id: TaskId,
    state: TaskState,
    start: number,
    errors: readonly unknown[],
    extra?: ResultExtra,
  ): void {
    const t = this.#now()
    this.#emit({ type, id, result: taskResult(state, start, t, errors, extra), t })
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

function expectedFailure(): CoreError {
  return new CoreError(
    'CORE_EXPECTED_FAILURE',
    'Failing test passed even though it was supposed to fail. Remove `.failing` to remove error.',
  )
}

/**
 * A `.failing`/`.fails` result reversed in place: errors are dropped (the expected failure), and
 * none becomes `CORE_EXPECTED_FAILURE`. `status.expectFail` picks whether it applies to the body
 * (jest-circus) or the whole attempt (Vitest's `fails`).
 */
function reverseExpectFail(errors: unknown[]): void {
  if (errors.length > 0) errors.length = 0
  else errors.push(expectedFailure())
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
