// The executor (T5.6): walks a collected file and runs it under `CorePolicy`, emitting
// `RuntimeEvent`s. One code path; every Jest/Vitest difference is a policy value (Track 5
// decisions 1 and 3). Reference behaviour: jest-circus 30.5's `_runTestsForDescribeBlock`/
// `_runTest` and Vitest 5.0's `runSuite`/`runTest`.
//
// One test attempt, in order: `aroundEach` (outer → inner) wraps `beforeEach` (parent → child),
// the body, `afterEach` (child → parent), the teardowns `beforeEach` returned, `LazyHost`
// teardowns (last first), `onTestFinished` (last first), then `onTestFailed` if it failed.
import type {
  CorePolicy,
  EventSink,
  FileTask,
  Frame,
  HookKind,
  LazyFrame,
  OrderHooks,
  RuntimeEvent,
  RuntimeHookKind,
  SkipReason,
  SuiteTask,
  TaskId,
  TaskInfo,
  TaskNode,
  TaskResult,
  TaskState,
  TestRunHandle,
  TestTask,
} from '@provino/types'
import { parseSite } from '../collector/location.ts'
import { runInStore, setRunningFrame } from '../current/current-test.ts'
import { CoreError, serializeError } from '../errors.ts'
import type {
  AttemptState,
  FileState,
  HookNode,
  Store,
  SuiteNode,
  TestNode,
  UserFn,
} from '../internal/model.ts'
import { type AroundCall, runAround } from './around.ts'
import { createTestContext } from './context.ts'
import { type RealTimers, withDeadline } from './deadline.ts'
import { invoke } from './invoke.ts'
import { createLimiter, type Limiter, unlimited } from './limiter.ts'

/** What the executor needs from the runtime. */
export interface ExecutorConfig {
  readonly policy: CorePolicy
  readonly orderHooks: OrderHooks | undefined
  readonly sink: EventSink
  readonly timers: RealTimers
  readonly now: () => number
  /** Each test context's run, for `LazyHost.runOf`. */
  readonly runs: WeakMap<object, TestRunHandle>
}

/** The outcome of one task. */
export type Outcome = 'pass' | 'fail' | 'skip' | 'todo'

/** One file while it runs. */
interface FileRun {
  readonly file: FileState
  readonly fileId: TaskId
  readonly tasks: ReadonlyMap<string, TaskNode>
}

/** What a suite passes to its children. */
interface Scope {
  /** `beforeAll` errors attached to every test below (`beforeAllError: 'attach-to-tests'`). */
  readonly attached: readonly unknown[]
  /** No hooks run below (`nestedHooksAfterBeforeAllError: 'skip'` after such an error). */
  readonly skipHooks: boolean
  /** Inside a concurrent group: the sync pointer stays unset. */
  readonly concurrent: boolean
}

/** A teardown a hook returned, with the hook it came from. */
interface Teardown {
  readonly fn: UserFn
  readonly owner: SuiteNode
  readonly ordinal: number
}

type Group = { readonly concurrent: boolean; readonly nodes: ReadonlyArray<SuiteNode | TestNode> }

/** Runs collected files. One per runtime. */
export class Executor {
  readonly #config: ExecutorConfig
  readonly #policy: CorePolicy
  /** `concurrency.limitHooks`: hooks and bodies share one `maxConcurrency` limit. */
  readonly #calls: Limiter
  /** With `limitHooks`, tests across groups share one `maxConcurrency` limit too (Vitest). */
  readonly #tests: Limiter

  constructor(config: ExecutorConfig) {
    this.#config = config
    this.#policy = config.policy
    const shared = config.policy.concurrency.limitHooks
    this.#calls = shared ? createLimiter(config.policy.maxConcurrency) : unlimited
    this.#tests = shared ? createLimiter(config.policy.maxConcurrency) : unlimited
  }

  /** Runs a collected file. File-level errors land in `file.errors`; the root's outcome is returned. */
  async runFile(file: FileState, tasks: readonly TaskNode[]): Promise<Outcome> {
    const run: FileRun = {
      file,
      fileId: file.root.id,
      tasks: new Map(tasks.map((task) => [task.id, task])),
    }
    return this.#runSuite(run, file.root, { attached: [], skipHooks: false, concurrent: false })
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
    const outcome: Outcome =
      errors.length > 0 || children.includes('fail')
        ? 'fail'
        : children.includes('pass') || children.length === 0
          ? suite.mode === 'skip'
            ? 'skip'
            : 'pass'
          : suite.mode === 'todo'
            ? 'todo'
            : 'skip'
    if (!isRoot) {
      this.#emit({
        type: 'suite-end',
        id: suite.id,
        result: this.#result(outcome, start, errors),
        t: this.#now(),
      })
    } else {
      run.file.errors.push(...errors)
    }
    return outcome
  }

  async #runSuiteBody(
    run: FileRun,
    suite: SuiteNode,
    scope: Scope,
    errors: unknown[],
  ): Promise<Outcome[]> {
    const policy = this.#policy
    const hooks = !scope.skipHooks && this.#suiteRunsHooks(suite)
    const teardowns: Teardown[] = []
    let outcomes: Outcome[] = []
    let ranInner = false
    const inner = async (): Promise<void> => {
      ranInner = true
      try {
        let attached = scope.attached
        let skipHooks = scope.skipHooks
        if (hooks) {
          const stop = policy.hooks.beforeAllError === 'skip-subtree'
          const failures = await this.#runLevel(run, suite, 'beforeAll', undefined, stop, teardowns)
          if (failures.length > 0) {
            if (stop) {
              errors.push(...failures)
              outcomes = this.#skipBelow(suite)
              return
            }
            attached = [...attached, ...failures]
            if (policy.hooks.nestedHooksAfterBeforeAllError === 'skip') skipHooks = true
          }
        }
        outcomes = await this.#runChildren(run, suite, {
          attached,
          skipHooks,
          concurrent: scope.concurrent,
        })
      } finally {
        if (hooks) {
          const abort = policy.hooks.afterError === 'abort-chain'
          const failures = await this.#runLevel(run, suite, 'afterAll', undefined, abort, undefined)
          if (!(abort && failures.length > 0)) {
            failures.push(...(await this.#runTeardowns(run, teardowns, 'afterAll', undefined)))
          }
          if (policy.hooks.afterAllError === 'fail-suite') errors.push(...failures)
          else run.file.errors.push(...failures)
        }
        if (suite.parent === null) await this.#fileTeardowns(run)
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

  async #fileTeardowns(run: FileRun): Promise<void> {
    const teardowns = run.file.handle.teardowns
    while (teardowns.length > 0) {
      const teardown = teardowns.pop()
      try {
        await teardown?.()
      } catch (error) {
        run.file.errors.push(error)
      }
    }
  }

  async #runChildren(run: FileRun, suite: SuiteNode, scope: Scope): Promise<Outcome[]> {
    const outcomes: Outcome[] = []
    for (const group of this.#groups(suite.children)) {
      if (!group.concurrent) {
        for (const node of group.nodes) outcomes.push(await this.#runChild(run, node, scope))
        continue
      }
      const limiter = createLimiter(this.#policy.maxConcurrency)
      const inner: Scope = { ...scope, concurrent: true }
      setRunningFrame(undefined)
      outcomes.push(
        ...(await Promise.all(
          group.nodes.map((node) => limiter.run(() => this.#runChild(run, node, inner))),
        )),
      )
    }
    return outcomes
  }

  #runChild(run: FileRun, node: SuiteNode | TestNode, scope: Scope): Promise<Outcome> {
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

  /** Reports every task below `suite` as skipped (a failed `beforeAll`, a blocked suite). */
  #skipBelow(suite: SuiteNode): Outcome[] {
    const outcomes: Outcome[] = []
    for (const child of suite.children) {
      const t = this.#now()
      if (child.type !== 'test') {
        this.#emit({ type: 'suite-start', id: child.id, t })
        this.#skipBelow(child)
        this.#emit({ type: 'suite-end', id: child.id, result: this.#result('skip', t, []), t })
      } else {
        this.#emit({ type: 'test-start', id: child.id, t })
        this.#emit({
          type: 'test-end',
          id: child.id,
          result: this.#result('skip', t, [], { skipReason: 'unknown' }),
          t,
        })
      }
      outcomes.push('skip')
    }
    return outcomes
  }

  // ---- tests --------------------------------------------------------------------------------

  async #runTest(run: FileRun, test: TestNode, scope: Scope): Promise<Outcome> {
    const start = this.#now()
    this.#emit({ type: 'test-start', id: test.id, t: start })
    if (test.mode === 'skip' || test.mode === 'todo') {
      const extra: { skipReason?: SkipReason } =
        test.mode === 'skip' ? { skipReason: test.skipReason ?? 'unknown' } : {}
      this.#emit({
        type: 'test-end',
        id: test.id,
        result: this.#result(test.mode, start, [], extra),
        t: this.#now(),
      })
      return test.mode
    }
    if (
      test.blocked !== undefined ||
      (test.retry > 0 && this.#policy.retry.timing === 'deferred')
    ) {
      const error =
        test.blocked ??
        new CoreError('CORE_NOT_IMPLEMENTED', 'Deferred retries (`retry.timing`) arrive with T5.10')
      this.#emit({
        type: 'test-end',
        id: test.id,
        result: this.#result('fail', start, [error]),
        t: this.#now(),
      })
      return 'fail'
    }
    const task = run.tasks.get(test.id) as TestTask
    const retryErrors: unknown[] = []
    const failures: unknown[] = []
    let attempts = 0
    let repeatIndex = 0
    for (let repeat = 0; repeat <= test.repeats; repeat++) {
      repeatIndex = repeat
      for (let attempt = 0; attempt <= test.retry; attempt++) {
        attempts++
        const errors = await this.#runAttempt(run, test, task, attempt, repeat, scope)
        const willRetry = errors.length > 0 && attempt < test.retry
        this.#emit({
          type: 'test-attempt-end',
          id: test.id,
          attempt,
          repeat,
          state: errors.length > 0 ? 'fail' : 'pass',
          errors: errors.map(serializeError),
          willRetry,
          t: this.#now(),
        })
        if (errors.length === 0) break
        if (willRetry) {
          if (this.#policy.retry.keepEarlierErrors) retryErrors.push(...errors)
        } else {
          failures.push(...errors)
        }
      }
    }
    const outcome: Outcome = failures.length > 0 ? 'fail' : 'pass'
    this.#emit({
      type: 'test-end',
      id: test.id,
      result: this.#result(outcome, start, failures, { retryErrors, attempts, repeatIndex }),
      t: this.#now(),
    })
    return outcome
  }

  async #runAttempt(
    run: FileRun,
    test: TestNode,
    task: TestTask,
    attempt: number,
    repeat: number,
    scope: Scope,
  ): Promise<unknown[]> {
    const info: TaskInfo = {
      name: test.name,
      fullName: test.fullName.join(this.#policy.nameSeparator),
      file: run.file.relativePath,
      retry: attempt,
      repeat,
    }
    let state: AttemptState | undefined
    const current = (): AttemptState => {
      if (state === undefined) throw new Error('unreachable: the attempt is read before it exists')
      return state
    }
    const ctx = createTestContext(task, current)
    const controller = new AbortController()
    const teardowns: Array<() => unknown> = []
    const handle: TestRunHandle = {
      test: { suite: test.parent.handle },
      ctx: { task: info },
      slots: new Map(),
      signal: controller.signal,
      get state(): 'running' | 'cleanup' | 'done' {
        return current().state
      },
      addTeardown(fn: () => unknown): void {
        teardowns.push(fn)
      },
    }
    const lazy: LazyFrame = {
      kind: 'test',
      run: handle,
      suite: test.parent.handle,
      file: run.file.handle,
    }
    state = {
      test,
      ctx,
      run: handle,
      lazy,
      state: 'running',
      controller,
      errors: [],
      onFinished: [],
      onFailed: [],
      teardowns,
      inCallbacks: false,
    }
    this.#config.runs.set(ctx, handle)
    const frame: Frame = { test: task, hook: null, fileId: run.fileId, attempt }
    const store: Store = { frame, lazy, collecting: undefined, attempt: state, hook: undefined }
    this.#emit({ type: 'test-attempt-start', id: test.id, attempt, repeat, t: this.#now() })
    setRunningFrame(scope.concurrent ? undefined : frame)
    try {
      await runInStore(store, () => this.#attemptBody(run, test, state, store, scope))
    } finally {
      state.state = 'done'
      setRunningFrame(undefined)
    }
    return state.errors
  }

  async #attemptBody(
    run: FileRun,
    test: TestNode,
    attempt: AttemptState,
    store: Store,
    scope: Scope,
  ): Promise<void> {
    const policy = this.#policy
    const errors = attempt.errors
    const eachHooks = !scope.skipHooks && (policy.eachHooksForConcurrent || !test.concurrent)
    const chain = suiteChain(test.parent)
    const deadline = policy.hooks.timeoutCountsTestTimeout
      ? this.#now() + test.timeoutMs
      : undefined
    const inner = async (): Promise<void> => {
      errors.push(...scope.attached)
      const teardowns: Teardown[] = []
      if (eachHooks && errors.length === 0) {
        for (const suite of chain) {
          const failures = await this.#runLevel(
            run,
            suite,
            'beforeEach',
            attempt,
            true,
            teardowns,
            deadline,
          )
          if (failures.length > 0) {
            errors.push(...failures)
            break
          }
        }
      }
      if (errors.length === 0) {
        const failures = await this.#runBody(test, attempt, store, deadline)
        if (!test.expectFail) errors.push(...failures)
        else if (failures.length === 0) {
          errors.push(
            new CoreError(
              'CORE_EXPECTED_FAILURE',
              'Failing test passed even though it was supposed to fail. Remove `.failing` to remove error.',
            ),
          )
        }
      }
      let aborted = false
      if (eachHooks) {
        const abort = policy.hooks.afterError === 'abort-chain'
        for (const suite of [...chain].reverse()) {
          const failures = await this.#runLevel(
            run,
            suite,
            'afterEach',
            attempt,
            abort,
            undefined,
            deadline,
          )
          errors.push(...failures)
          if (abort && failures.length > 0) {
            aborted = true
            break
          }
        }
      }
      if (!aborted) errors.push(...(await this.#runTeardowns(run, teardowns, 'afterEach', attempt)))
      attempt.state = 'cleanup'
      while (attempt.teardowns.length > 0) {
        const teardown = attempt.teardowns.pop()
        try {
          await runInStore(store, async () => teardown?.())
        } catch (error) {
          errors.push(error)
        }
      }
      attempt.inCallbacks = true
      const finished = attempt.onFinished.toReversed()
      errors.push(...(await this.#runCallbacks(run, attempt, store, finished, 'onTestFinished')))
      if (errors.length > 0) {
        const failed = this.#order(attempt.onFailed, 'afterEach')
        errors.push(...(await this.#runCallbacks(run, attempt, store, failed, 'onTestFailed')))
      }
    }
    const around = eachHooks ? chain.flatMap((suite) => suite.hooks.aroundEach) : []
    if (around.length === 0) {
      await inner()
      return
    }
    errors.push(
      ...(await runAround(
        around.map((hook) => this.#aroundCall(run, hook, attempt)),
        () => runInStore(store, inner),
        {
          kind: 'aroundEach',
          timers: this.#config.timers,
          onTimeout: (error) => attempt.controller.abort(error),
        },
      )),
    )
  }

  async #runBody(
    test: TestNode,
    attempt: AttemptState,
    store: Store,
    deadline: number | undefined,
  ): Promise<unknown[]> {
    const fn = test.fn
    if (fn === undefined) return []
    const policy = this.#policy
    const contextArgs =
      test.passContext && (test.rowArgs !== undefined || policy.firstArg === 'context')
        ? [attempt.ctx]
        : []
    const timeoutMs = deadline === undefined ? test.timeoutMs : Math.max(1, deadline - this.#now())
    try {
      await this.#calls.run(() =>
        runInStore(store, () =>
          withDeadline(
            () =>
              invoke(policy, {
                fn,
                thisArg: policy.firstArg === 'context' ? undefined : {},
                args: test.rowArgs ?? [],
                contextArgs,
                isTest: true,
              }),
            {
              timeoutMs,
              catchSyncOverrun: policy.timeouts.catchSyncOverrun,
              timers: this.#config.timers,
              now: this.#config.now,
              timeoutError: () =>
                new CoreError('CORE_TIMEOUT', `Test timed out in ${test.timeoutMs}ms.`),
              onTimeout: (error) => attempt.controller.abort(error),
            },
          ),
        ),
      )
      return []
    } catch (error) {
      return [error]
    }
  }

  // ---- hooks --------------------------------------------------------------------------------

  /**
   * Runs one suite's hooks of one kind, in `hookOrder`. `stop`: the first failure ends the level
   * (sequential orders only). `teardowns` collects returned functions (`hookReturnsCleanup`).
   */
  async #runLevel(
    run: FileRun,
    suite: SuiteNode,
    kind: HookKind,
    attempt: AttemptState | undefined,
    stop: boolean,
    teardowns: Teardown[] | undefined,
    deadline?: number,
  ): Promise<unknown[]> {
    const hooks = suite.hooks[kind]
    if (hooks.length === 0) return []
    const failures: unknown[] = []
    const call = async (hook: HookNode): Promise<void> => {
      const result = await this.#callHook(run, hook, attempt, deadline)
      if (result.ok) {
        if (teardowns !== undefined && this.#policy.hookReturnsCleanup) {
          if (typeof result.value === 'function') {
            teardowns.push({ fn: result.value as UserFn, owner: suite, ordinal: hook.ordinal })
          }
        }
      } else {
        failures.push(result.error)
      }
    }
    if (this.#parallel(kind)) {
      await Promise.all(hooks.map(call))
      return failures
    }
    for (const hook of this.#order(hooks, kind)) {
      await call(hook)
      if (stop && failures.length > 0) break
    }
    return failures
  }

  async #callHook(
    run: FileRun,
    hook: HookNode,
    attempt: AttemptState | undefined,
    deadline: number | undefined,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
    const policy = this.#policy
    const each = hook.kind === 'beforeEach' || hook.kind === 'afterEach'
    const suiteArg = this.#suiteTask(
      run,
      each && attempt !== undefined ? attempt.test.parent : hook.owner,
    )
    const contextArgs =
      policy.firstArg !== 'context'
        ? []
        : each && attempt !== undefined
          ? [attempt.ctx, suiteArg]
          : [suiteArg]
    const timeoutMs =
      each && deadline !== undefined
        ? Math.max(1, deadline - this.#now())
        : (hook.timeoutMs ?? policy.timeouts.hook)
    return this.#callUser(run, {
      kind: hook.kind,
      owner: hook.owner,
      ordinal: hook.ordinal,
      location: parseSite(hook.site),
      attempt,
      timeoutMs,
      call: () =>
        invoke(policy, {
          fn: hook.fn,
          thisArg: policy.firstArg === 'context' ? undefined : {},
          args: [],
          contextArgs,
          isTest: false,
        }),
    })
  }

  /** Calls one hook-like user function in its own store, with events, a deadline and the limiter. */
  async #callUser(
    run: FileRun,
    spec: {
      readonly kind: RuntimeHookKind
      readonly owner: SuiteNode
      readonly ordinal: number
      readonly location: ReturnType<typeof parseSite>
      readonly attempt: AttemptState | undefined
      readonly timeoutMs: number
      readonly call: () => unknown
    },
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
    const { attempt, kind, owner } = spec
    const testId = attempt?.test.id ?? null
    const frame: Frame = {
      test: attempt === undefined ? null : (run.tasks.get(attempt.test.id) as TestTask),
      hook: { kind, ownerId: owner.id },
      fileId: run.fileId,
      attempt: attempt?.run.ctx.task.retry ?? 0,
    }
    const lazy: LazyFrame =
      attempt === undefined
        ? {
            kind: 'suite',
            hook: kind === 'afterAll' || kind === 'teardown' ? 'afterAll' : 'beforeAll',
            suite: owner.handle,
            file: run.file.handle,
          }
        : attempt.lazy
    const store: Store = { frame, lazy, collecting: undefined, attempt, hook: kind }
    this.#emit({
      type: 'hook-start',
      ownerId: owner.id,
      testId,
      kind,
      ordinal: spec.ordinal,
      location: spec.location,
      t: this.#now(),
    })
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown }
    try {
      const value = await this.#calls.run(() =>
        runInStore(store, () =>
          withDeadline(spec.call, {
            timeoutMs: spec.timeoutMs,
            catchSyncOverrun: this.#policy.timeouts.catchSyncOverrun,
            timers: this.#config.timers,
            now: this.#config.now,
            timeoutError: () =>
              new CoreError('CORE_TIMEOUT', `Hook timed out in ${spec.timeoutMs}ms.`),
            ...(attempt === undefined
              ? {}
              : { onTimeout: (error: Error) => attempt.controller.abort(error) }),
          }),
        ),
      )
      outcome = { ok: true, value }
    } catch (error) {
      outcome = { ok: false, error }
    }
    this.#emit({
      type: 'hook-end',
      ownerId: owner.id,
      testId,
      kind,
      ordinal: spec.ordinal,
      error: outcome.ok ? null : serializeError(outcome.error),
      t: this.#now(),
    })
    return outcome
  }

  /** Runs the teardowns hooks returned, in the order of `hookOrder[after]`. */
  async #runTeardowns(
    run: FileRun,
    teardowns: readonly Teardown[],
    after: 'afterEach' | 'afterAll',
    attempt: AttemptState | undefined,
  ): Promise<unknown[]> {
    if (teardowns.length === 0) return []
    const failures: unknown[] = []
    const abort = this.#policy.hooks.afterError === 'abort-chain'
    const call = async (teardown: Teardown): Promise<void> => {
      const result = await this.#callUser(run, {
        kind: 'teardown',
        owner: teardown.owner,
        ordinal: teardown.ordinal,
        location: null,
        attempt,
        timeoutMs: this.#policy.timeouts.teardown,
        call: () => Reflect.apply(teardown.fn, undefined, []),
      })
      if (!result.ok) failures.push(result.error)
    }
    if (this.#parallel(after)) {
      await Promise.all(teardowns.map(call))
      return failures
    }
    for (const teardown of this.#order(teardowns, after)) {
      await call(teardown)
      if (abort && failures.length > 0) break
    }
    return failures
  }

  async #runCallbacks(
    run: FileRun,
    attempt: AttemptState,
    _store: Store,
    callbacks: ReadonlyArray<{ fn: UserFn; timeoutMs: number | undefined }>,
    kind: 'onTestFinished' | 'onTestFailed',
  ): Promise<unknown[]> {
    const failures: unknown[] = []
    for (const [ordinal, callback] of callbacks.entries()) {
      const result = await this.#callUser(run, {
        kind,
        owner: attempt.test.parent,
        ordinal,
        location: null,
        attempt,
        timeoutMs: callback.timeoutMs ?? this.#policy.timeouts.hook,
        call: () => Reflect.apply(callback.fn, undefined, [attempt.ctx]),
      })
      if (!result.ok) failures.push(result.error)
    }
    return failures
  }

  #aroundCall(run: FileRun, hook: HookNode, attempt: AttemptState | undefined): AroundCall {
    const kind = hook.kind as 'aroundEach' | 'aroundAll'
    const timeoutMs = hook.timeoutMs ?? this.#policy.timeouts.hook
    const lazy: LazyFrame =
      attempt === undefined
        ? { kind: 'suite', hook: 'beforeAll', suite: hook.owner.handle, file: run.file.handle }
        : attempt.lazy
    const store: Store = {
      frame: {
        test: attempt === undefined ? null : (run.tasks.get(attempt.test.id) as TestTask),
        hook: { kind, ownerId: hook.owner.id },
        fileId: run.fileId,
        attempt: attempt?.run.ctx.task.retry ?? 0,
      },
      lazy,
      collecting: undefined,
      attempt,
      hook: kind,
    }
    return {
      timeoutMs,
      invoke: async (inner) => {
        const testId = attempt?.test.id ?? null
        const base = { ownerId: hook.owner.id, testId, kind, ordinal: hook.ordinal }
        this.#emit({ type: 'hook-start', ...base, location: parseSite(hook.site), t: this.#now() })
        try {
          const args =
            attempt === undefined ? [inner, this.#suiteTask(run, hook.owner)] : [inner, attempt.ctx]
          await runInStore(store, () => Reflect.apply(hook.fn, undefined, args))
          this.#emit({ type: 'hook-end', ...base, error: null, t: this.#now() })
        } catch (error) {
          this.#emit({ type: 'hook-end', ...base, error: serializeError(error), t: this.#now() })
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

  #suiteTask(run: FileRun, suite: SuiteNode): SuiteTask | FileTask {
    return run.tasks.get(suite.id) as SuiteTask | FileTask
  }

  #now(): number {
    return this.#config.now()
  }

  #emit(event: RuntimeEvent): void {
    this.#config.sink.emit(event)
  }

  #result(
    state: TaskState,
    start: number,
    errors: readonly unknown[],
    extra: {
      readonly skipReason?: SkipReason
      readonly retryErrors?: readonly unknown[]
      readonly attempts?: number
      readonly repeatIndex?: number
    } = {},
  ): TaskResult {
    return {
      state,
      durationMs: this.#now() - start,
      startTime: start,
      errors: errors.map(serializeError),
      retryErrors: (extra.retryErrors ?? []).map(serializeError),
      attempts: extra.attempts ?? 0,
      repeatIndex: extra.repeatIndex ?? 0,
      assertions: 0,
      passingAssertions: 0,
      ...(extra.skipReason === undefined ? {} : { skipReason: extra.skipReason }),
    }
  }
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
