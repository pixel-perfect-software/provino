// The collector's mutable tree and the async-context store. Everything here is worker-only and
// never crosses threads; the clone-safe `TaskNode`s are built from it once collection ends.
import type {
  FileHandle,
  Frame,
  JsonValue,
  LazyFrame,
  RunMode,
  RuntimeHookKind,
  SourceLocation,
  SuiteHandle,
  TaskId,
  TestContext,
  TestRunHandle,
} from '@provino/types'
import type { Site } from '../collector/location.ts'

/** A user function as stored: any function is assignable; it is called with `Reflect.apply`. */
export type UserFn = (...args: never[]) => unknown

/** The hooks a suite can declare. */
export type DeclaredHookKind =
  | 'beforeAll'
  | 'beforeEach'
  | 'afterEach'
  | 'afterAll'
  | 'aroundEach'
  | 'aroundAll'

/** One declared hook. `ordinal` is its index among the owner's hooks of the same kind. */
export interface HookNode {
  readonly kind: DeclaredHookKind
  readonly fn: UserFn
  readonly ordinal: number
  readonly owner: SuiteNode
  readonly timeoutMs: number | undefined
  readonly site: Site | null
}

/** Options a suite passes down to its children (Vitest's options object). */
export interface InheritedOptions {
  readonly timeout?: number
  readonly retry?: number
  readonly repeats?: number
  readonly concurrent?: boolean
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
  skipReason: 'modifier' | 'only-filter' | 'name-filter' | 'condition' | undefined
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

/** One run (attempt) of a test, while it runs. */
export interface AttemptState {
  readonly test: TestNode
  readonly ctx: TestContext
  readonly run: TestRunHandle
  /** The one `LazyFrame` every hook, the body and the teardowns of this attempt run in. */
  readonly lazy: LazyFrame
  /** What `run.state` reports. */
  state: 'running' | 'cleanup' | 'done'
  readonly controller: AbortController
  readonly errors: unknown[]
  readonly onFinished: Array<{ fn: UserFn; timeoutMs: number | undefined }>
  readonly onFailed: Array<{ fn: UserFn; timeoutMs: number | undefined }>
  readonly teardowns: Array<() => unknown>
  /** `true` while `onTestFinished`/`onTestFailed` callbacks run (they may not add more). */
  inCallbacks: boolean
}

/** A location as the tree carries it. */
export type Location = SourceLocation | null
