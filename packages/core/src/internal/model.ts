// The collector's mutable tree and the async-context store. Everything here is worker-only and
// never crosses threads; the clone-safe `TaskNode`s are built from it once collection ends.
import type {
  AnyFunction,
  FileHandle,
  FileTask,
  Frame,
  JsonValue,
  LazyFrame,
  RunMode,
  RuntimeHookKind,
  SkipReason,
  SourceLocation,
  SuiteHandle,
  SuiteTask,
  TaskId,
  TestContext,
  TestRunHandle,
  TestTask,
} from '@provino/types'
import type { Site } from '../collector/location.ts'

/** A user function as stored: any function is assignable; it is called with `Reflect.apply`. */
export type UserFn = AnyFunction

/** The hooks a suite can declare. */
export type DeclaredHookKind =
  | 'beforeAll'
  | 'beforeEach'
  | 'afterEach'
  | 'afterAll'
  | 'aroundEach'
  | 'aroundAll'

/** Why a node is skipped, as registration, focus and the filters decide it. */
export type NodeSkipReason = Extract<
  SkipReason,
  'modifier' | 'only-filter' | 'name-filter' | 'condition'
>

/** One declared hook. `ordinal` is its index among the owner's hooks of the same kind. */
export interface HookNode {
  readonly kind: DeclaredHookKind
  readonly fn: UserFn
  readonly ordinal: number
  readonly owner: SuiteNode
  readonly timeoutMs: number | undefined
  /** The captured callsite, until the tree is built and it is parsed into `location`. */
  site: Site | null
  /** Where the hook was registered (the first frame in the test file), filled when the tree is built. */
  location: SourceLocation | null
}

/**
 * Options a suite passes down to its children (Vitest's options object, merged into every child's
 * own). The mode keys come from options objects only: a chained `describe.only` passes nothing.
 */
export interface InheritedOptions {
  readonly timeout?: number | undefined
  readonly retry?: number | undefined
  readonly repeats?: number | undefined
  readonly concurrent?: boolean | undefined
  readonly only?: boolean | undefined
  readonly skip?: boolean | undefined
  readonly todo?: boolean | undefined
  readonly tags: readonly string[]
  readonly meta: Readonly<Record<string, JsonValue>>
}

/** The fields suites and tests share while collecting. */
interface NodeBase {
  readonly name: string
  readonly site: Site | null
  /** The mode the code declared (`.only`, `.skip`, `.todo`), before focus and filters. */
  declared: RunMode | undefined
  /** The mode after focus and filters: what actually happens. */
  mode: RunMode
  /** Set at registration for a declared skip (`modifier`, or `condition` for `skipIf`/`runIf`). */
  skipReason: NodeSkipReason | undefined
  id: TaskId
  readonly each: boolean
  /** An error the node fails with before it runs (`.only` where the policy forbids it). */
  blocked?: unknown
  /** The parsed location, filled when the tree is built. */
  location?: SourceLocation | null
}

/** A file's root or a `describe` block. */
export interface SuiteNode extends NodeBase {
  readonly type: 'file' | 'suite'
  readonly parent: SuiteNode | null
  readonly file: FileState
  readonly children: Array<SuiteNode | TestNode>
  readonly hooks: { readonly [K in DeclaredHookKind]: HookNode[] }
  readonly options: InheritedOptions
  /** `true`, `false`, or `undefined` when the code didn't say. */
  readonly concurrent: boolean | undefined
  readonly shuffle: boolean
  /** The body, kept until it runs (deferred bodies run after the file has loaded). */
  body: UserFn | undefined
  readonly bodyArgs: readonly unknown[]
  readonly handle: SuiteHandle
  /** Set when the suite has no tests and `collect.emptyDescribe` fails it. */
  emptyError?: unknown
  /** The clone-safe task (the `FileTask` for the root), set when the tree is built. */
  task: SuiteTask | FileTask | undefined
}

/** A test. */
export interface TestNode extends NodeBase {
  readonly type: 'test'
  readonly parent: SuiteNode
  readonly fn: UserFn | undefined
  /** Arguments a `.each`/`.for` row passes before the context or `done`. */
  readonly rowArgs: readonly unknown[] | undefined
  /** `.for` passes the context after the row; `.each` never passes one. */
  readonly passContext: boolean
  readonly concurrent: boolean
  readonly expectFail: boolean
  readonly timeoutMs: number
  readonly retry: number
  readonly repeats: number
  readonly tags: readonly string[]
  readonly meta: Readonly<Record<string, JsonValue>>
  fullName: readonly string[]
  dupIndex: number
  /** The clone-safe task, set when the tree is built. */
  task: TestTask | undefined
}

/** One file being collected and run. */
export interface FileState {
  /** Absolute path, as the caller gave it. */
  readonly path: string
  /** POSIX, relative to the project root. */
  readonly relativePath: string
  readonly root: SuiteNode
  readonly handle: FileHandle
  /** File-level errors: collection failures and the policy's file-failing errors. */
  readonly errors: unknown[]
  /** `true` once collection is over: later registrations are late. */
  collected: boolean
  readonly onCollected: Array<(file: FileHandle) => void>
  /** This file's suites by handle (`LazyHost.addHook` finds its suite here). */
  readonly suites: WeakMap<SuiteHandle, SuiteNode>
}

/**
 * What the current async context is running. One store per test attempt covers its each-hooks,
 * body and teardowns (LazyHost guarantee 1); each hook runs in a child store that shares `lazy`.
 */
export interface Store {
  /** The `CurrentTest` view. */
  readonly frame: Frame | undefined
  /** The `LazyHost` view; the same object for every hook of one test attempt. */
  readonly lazy: LazyFrame | undefined
  /** Set while a describe body (or the file's top level) is registering. */
  readonly collecting: SuiteNode | undefined
  /** Set inside a test attempt. */
  readonly attempt: AttemptState | undefined
  /** The hook running, if any. */
  readonly hook: RuntimeHookKind | undefined
}

/** An `onTestFinished`/`onTestFailed` callback. */
export interface TestCallback {
  readonly fn: UserFn
  readonly timeoutMs: number | undefined
}

/** One run (attempt) of a test, while it runs. */
export interface AttemptState {
  readonly test: TestNode
  readonly ctx: TestContext
  /**
   * `this` for the attempt's `beforeEach`, body and `afterEach`: one object they share (jest-circus's
   * per-test `testContext`), or `undefined` under `firstArg: 'context'`.
   */
  readonly thisArg: object | undefined
  readonly run: TestRunHandle
  /** The one `LazyFrame` every hook, the body and the teardowns of this attempt run in. */
  readonly lazy: LazyFrame
  /** The attempt's `CurrentTest` frame; a hook's frame adds its hook to the same test and attempt. */
  readonly frame: Frame
  /** What `run.state` reports. */
  state: 'running' | 'cleanup' | 'done'
  readonly controller: AbortController
  readonly errors: unknown[]
  readonly onFinished: TestCallback[]
  readonly onFailed: TestCallback[]
  readonly teardowns: Array<() => unknown>
  /** `true` while `onTestFinished`/`onTestFailed` callbacks run (they may not add more). */
  inCallbacks: boolean
  /**
   * When the each-hooks and body must be done (`hooks.timeoutCountsTestTimeout`; `Infinity` for a
   * test with no timeout), set as the attempt starts; `undefined` when each call has its own.
   */
  deadline: number | undefined
}
