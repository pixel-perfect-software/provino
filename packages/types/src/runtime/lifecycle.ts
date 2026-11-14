// The lifecycle events of one file's run, worker-local: what an environment's `onTestEvent` (Jest's
// `handleTestEvent`) sees. They are not `RuntimeEvent`s: they never cross a link, they carry live
// values (the errors as thrown, the functions as registered) and nodes by identity, and the runtime
// awaits the listener at each run event, so a slow listener slows the run. The definition events
// are called synchronously while the file is collected and their result is not awaited. A run with
// no listener pays for none of it.
import type { AnyFunction } from '../policy/behaviour.ts'
import type { RuntimeHookKind } from './events.ts'
import type { TaskId } from './tree.ts'

/**
 * A suite, test or file as an event names it: the same object every event about it carries, so a
 * listener can key what it builds by it. Nothing else of the runtime's node is part of the contract.
 * @public
 */
export interface LifecycleRef {
  readonly type: 'file' | 'suite' | 'test'
  readonly name: string
}

/**
 * The mode a registration declared (`only`, `skip`, `todo`), or `undefined` when it declared none.
 * @public
 */
export type LifecycleMode = 'only' | 'skip' | 'todo' | undefined

/**
 * One step of a file's life, in the order the runtime reaches it: the file's set-up, the
 * definitions as the file registers them, then the run (suites, tests, hooks, bodies, retries),
 * then the tear-down. `file-setup` comes before anything of the file loads and `file-teardown`
 * after the run, for a file that was collected.
 * @public
 */
export type LifecycleEvent =
  | { readonly type: 'file-setup'; readonly root: LifecycleRef; readonly testNamePattern?: string }
  | { readonly type: 'file-teardown' }
  | {
      readonly type: 'define-suite-start'
      readonly ref: LifecycleRef
      readonly parent: LifecycleRef
      readonly mode: LifecycleMode
    }
  | { readonly type: 'define-suite-end'; readonly ref: LifecycleRef; readonly mode: LifecycleMode }
  | {
      readonly type: 'define-hook'
      readonly owner: LifecycleRef
      readonly kind:
        | 'beforeAll'
        | 'beforeEach'
        | 'afterEach'
        | 'afterAll'
        | 'aroundAll'
        | 'aroundEach'
      readonly fn: AnyFunction
      readonly timeoutMs: number | undefined
    }
  | {
      readonly type: 'define-test'
      readonly ref: LifecycleRef
      readonly parent: LifecycleRef
      readonly fn: AnyFunction | undefined
      readonly mode: LifecycleMode
      readonly concurrent: boolean
      readonly failing: boolean
      readonly timeoutMs: number | undefined
    }
  | {
      readonly type: 'run-start'
      /** The default timeout of a test or hook with none of its own, in effect for the run. */
      readonly timeoutMs: number
    }
  | { readonly type: 'run-end' }
  | { readonly type: 'suite-start'; readonly ref: LifecycleRef }
  | { readonly type: 'suite-end'; readonly ref: LifecycleRef }
  | {
      /** A whole-describe retry is about to run the block again. */
      readonly type: 'suite-retry'
      readonly ref: LifecycleRef
      readonly keepEarlierErrors: boolean
    }
  | {
      readonly type: 'concurrent-start' | 'concurrent-end'
      readonly ref: LifecycleRef
      readonly tests: readonly LifecycleRef[]
    }
  | { readonly type: 'test-start'; readonly ref: LifecycleRef; readonly id: TaskId }
  | { readonly type: 'test-started'; readonly ref: LifecycleRef }
  | { readonly type: 'test-skip'; readonly ref: LifecycleRef }
  | { readonly type: 'test-todo'; readonly ref: LifecycleRef }
  | {
      /** The attempt ended. `errors` is everything it failed with, as the runtime holds it now. */
      readonly type: 'test-done'
      readonly ref: LifecycleRef
      readonly errors: readonly unknown[]
    }
  | {
      /** A retry of the test is about to start; `keepEarlierErrors` says whether the failed attempt's errors are kept. */
      readonly type: 'test-retry'
      readonly ref: LifecycleRef
      readonly keepEarlierErrors: boolean
    }
  | {
      readonly type: 'hook-start'
      readonly owner: LifecycleRef
      readonly kind: RuntimeHookKind
      readonly ordinal: number
      /** The test the hook runs for; `undefined` for a suite's hook. */
      readonly test: LifecycleRef | undefined
    }
  | {
      readonly type: 'hook-end'
      readonly owner: LifecycleRef
      readonly kind: RuntimeHookKind
      readonly ordinal: number
      readonly test: LifecycleRef | undefined
      readonly failed: boolean
      /** What the hook threw; meaningful when `failed`. */
      readonly error: unknown
    }
  | { readonly type: 'fn-start'; readonly ref: LifecycleRef }
  | {
      readonly type: 'fn-end'
      readonly ref: LifecycleRef
      readonly failed: boolean
      /** What the body failed with (after a `.failing` test's reversal); meaningful when `failed`. */
      readonly error: unknown
    }

/**
 * Receives a file's lifecycle events. Returning a promise makes the runtime wait for it at the
 * run events; at the definition events the result is not awaited.
 * @public
 */
export type LifecycleListener = (event: LifecycleEvent) => void | Promise<void>
