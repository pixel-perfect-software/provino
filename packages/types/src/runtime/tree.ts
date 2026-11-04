// Track 5 §Types → Task tree. Nodes hold ids, never object links, so the tree is clone-safe and
// crosses threads as a flat list. Full names stay arrays; joining them is a dialect concern
// (`core.nameSeparator`).
import type { JsonValue } from '../clone-safe.ts'

/**
 * A task's id: a hash of the project and the file's relative path, plus the child index path
 * (as Vitest does). Stable across runs of the same file.
 * @public
 */
export type TaskId = string & { readonly __brand: 'TaskId' }

/**
 * A position in a source file. `line` and `column` are 1-based.
 * @public
 */
export interface SourceLocation {
  readonly file: string
  readonly line: number
  readonly column: number
}

/**
 * How a task was declared to run: normally, skipped, focused or as a todo.
 * @public
 */
export type RunMode = 'run' | 'skip' | 'only' | 'todo'

/**
 * Where a task is in its life.
 * @public
 */
export type TaskState = 'queued' | 'running' | 'pass' | 'fail' | 'skip' | 'todo'

/**
 * Why a test was skipped, when the runner can say (Track 12 needs it for parity).
 * @public
 */
export type SkipReason =
  | 'modifier'
  | 'only-filter'
  | 'name-filter'
  | 'condition'
  | 'dynamic'
  | 'unknown'

/**
 * The fields every task node has.
 * @public
 */
export interface TaskBase {
  readonly id: TaskId
  /** `null` for a file. */
  readonly parentId: TaskId | null
  readonly fileId: TaskId
  readonly name: string
  readonly mode: RunMode
  readonly location: SourceLocation | null
  readonly tags: readonly string[]
  readonly meta: Readonly<Record<string, JsonValue>>
}

/**
 * A test file: the root of its task tree.
 * @public
 */
export interface FileTask extends TaskBase {
  readonly type: 'file'
  /** POSIX, relative to the project root. */
  readonly path: string
  readonly projectName: string
  readonly children: readonly TaskId[]
}

/**
 * A `describe` block.
 * @public
 */
export interface SuiteTask extends TaskBase {
  readonly type: 'suite'
  readonly children: readonly TaskId[]
  readonly each: boolean
  readonly concurrent: boolean
  readonly shuffle: boolean
}

/**
 * A test.
 * @public
 */
export interface TestTask extends TaskBase {
  readonly type: 'test'
  /** Describe titles, then the test title. No file name, never joined. */
  readonly fullName: readonly string[]
  /**
   * 0-based among tests in the same file with the same `fullName`, in declaration order (Track
   * 12's test identity; `testKey` in `@provino/harness` uses the same rule).
   */
  readonly dupIndex: number
  readonly each: boolean
  readonly concurrent: boolean
  /** `test.failing` (Jest) or `test.fails` (Vitest). */
  readonly expectFail: boolean
  readonly timeoutMs: number
  /** Retries configured for the test, not the attempt number. */
  readonly retry: number
  readonly repeats: number
}

/**
 * A node of the task tree. The one definition: the event stream, the reporter bus, IDE adapters
 * and the harness all use it.
 * @public
 */
export type TaskNode = FileTask | SuiteTask | TestTask

/**
 * An error as it crosses threads: plain data, with its cause chain and aggregate errors.
 * @public
 */
export interface SerializedError {
  /**
   * Phantom, never set: marks this as plain data, not an `Error` instance, so `CloneSafe` keeps
   * its extra fields (`code`, `diff`, …) instead of rejecting them.
   */
  readonly __record?: never
  readonly name: string
  readonly message: string
  readonly stack?: string
  readonly code?: string
  readonly cause?: SerializedError
  readonly errors?: readonly SerializedError[]
  /** Filled by the expect layer (Track 7). */
  readonly diff?: { readonly expected: string; readonly actual: string }
  /**
   * The matcher that failed, from the error's `matcherResult` (Jest's
   * `failureDetails[i].matcherResult`): its `name` and whether it `pass`ed. Only these two fields
   * cross; the rest of the result (messages, `actual`, `expected`) can hold anything.
   */
  readonly matcherResult?: { readonly name: string; readonly pass: boolean }
  readonly location?: SourceLocation
}

/**
 * A task's outcome. Files and suites use the same shape; the test-only fields are zero or absent
 * on them.
 * @public
 */
export interface TaskResult {
  readonly state: TaskState
  readonly durationMs: number
  /** Monotonic ms, the same clock as each event's `t`. */
  readonly startTime: number
  readonly errors: readonly SerializedError[]
  /** Errors from earlier attempts, kept when the policy says so (`core.retry.keepEarlierErrors`). */
  readonly retryErrors: readonly SerializedError[]
  readonly attempts: number
  readonly repeatIndex: number
  /** `expect` calls made. */
  readonly assertions: number
  /** `expect` calls that passed (Jest's `numPassingAsserts`). */
  readonly passingAssertions: number
  /** Set when `state` is `skip`. */
  readonly skipReason?: SkipReason
  /** The note given to `ctx.skip(note)` or `test.todo`. */
  readonly note?: string
}
