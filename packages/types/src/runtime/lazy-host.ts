// Track 6 §Module boundaries: the host interface `@provino/lazy` needs, which `@provino/core`'s
// executor implements (B07 checks that with a type test, §4 D.23). Worker-only, never cloned.
//
// Requirements on the executor that the types can't show:
// - One AsyncLocalStorage frame per test run, covering `beforeEach`, the body, `afterEach` and
//   teardowns, so they share one memo. Suite hooks get a `suite` frame.
// - `frame.suite` is the test's innermost suite, not the suite a hook was declared in.
// - Teardowns run after `afterEach`; `state` becomes `'cleanup'` before they run.
// - `slots` on a run is fresh for every attempt (retry and repeat).

/**
 * What a lazy value's definition sees of the current test.
 * @public
 */
export interface TaskInfo {
  readonly name: string
  /** The full name, joined by the dialect's separator. */
  readonly fullName: string
  readonly file: string
  readonly retry: number
  readonly repeat: number
}

/**
 * A test file, as the lazy layer sees it.
 * @public
 */
export interface FileHandle {
  readonly name: string
  readonly root: SuiteHandle
  readonly slots: Map<symbol, unknown>
  readonly teardowns: Array<() => unknown>
  readonly signal: AbortSignal
}

/**
 * A suite, as the lazy layer sees it.
 * @public
 */
export interface SuiteHandle {
  readonly name: string
  readonly parent: SuiteHandle | undefined
  readonly file: FileHandle
  readonly slots: Map<symbol, unknown>
}

/**
 * One run (attempt) of a test.
 * @public
 */
export interface TestRunHandle {
  readonly test: { readonly suite: SuiteHandle }
  readonly ctx: { readonly task: TaskInfo }
  /** Fresh for every attempt (retry and repeat). */
  readonly slots: Map<symbol, unknown>
  readonly signal: AbortSignal
  readonly state: 'running' | 'cleanup' | 'done'
  /** Runs last first, after `afterEach`, even when the test failed. */
  addTeardown(fn: () => unknown): void
}

/**
 * The frame the current async context runs in: a test run (its hooks and body), or a suite hook.
 * @public
 */
export type LazyFrame =
  | {
      readonly kind: 'test'
      readonly run: TestRunHandle
      /** The test's innermost suite. */
      readonly suite: SuiteHandle
      readonly file: FileHandle
    }
  | {
      readonly kind: 'suite'
      readonly hook: 'beforeAll' | 'afterAll'
      readonly suite: SuiteHandle
      readonly file: FileHandle
    }

/**
 * What `@provino/lazy` needs from the runtime. `@provino/core`'s executor implements it.
 * @public
 */
export interface LazyHost {
  /** The suite being collected; set synchronously while a describe body runs. */
  collecting(): SuiteHandle | undefined
  /** The frame the current async context runs in. */
  current(): LazyFrame | undefined
  /** Adds a hook at the current position of a suite's hook list (for eager values). */
  addHook(suite: SuiteHandle, kind: 'beforeEach' | 'beforeAll', fn: () => unknown): void
  /** The run a test or hook context belongs to (for `$.from(ctx)`). */
  runOf(ctx: object): TestRunHandle | undefined
  /** Called once per file after collection, before any test runs. */
  onCollected(fn: (file: FileHandle) => void): void
  addWorkerTeardown(fn: () => unknown): void
  readonly workerSlots: Map<symbol, unknown>
}
