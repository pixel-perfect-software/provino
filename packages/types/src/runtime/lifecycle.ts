// The lifecycle events of one file's run, worker-local: what an environment's `onTestEvent` (Jest's
// `handleTestEvent`) sees. They are not `RuntimeEvent`s: they never cross a link, they carry live
// values (the errors as thrown, the functions as registered) and nodes by identity, and the runtime
// awaits the listener at each run event, so a slow listener slows the run. The definition events
// are called synchronously while the file is collected and their result is not awaited. A run with
// no listener pays for none of it.
import type { AnyFunction } from '../policy/behaviour.ts'
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
 * The kinds of hook a test file declares.
 * @public
 */
export type LifecycleHookKind =
  | 'beforeAll'
  | 'beforeEach'
  | 'afterEach'
  | 'afterAll'
  | 'aroundAll'
  | 'aroundEach'

/**
 * A hook the file declared, as the events name it: the same object `define-hook`, `hook-start` and
 * `hook-end` carry, so a listener can key what it builds by it. A hook the runtime adds for itself
 * (an eager lazy value's) is never one: no event names it.
 * @public
 */
export interface LifecycleHookRef {
  readonly kind: LifecycleHookKind
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
  | {
      readonly type: 'file-setup'
      readonly root: LifecycleRef
      /** The file's name pattern as it was given: the string itself, or a `RegExp`'s `source`. */
      readonly testNamePattern?: string
    }
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
      readonly hook: LifecycleHookRef
      readonly owner: LifecycleRef
      readonly kind: LifecycleHookKind
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
      readonly hook: LifecycleHookRef
      readonly owner: LifecycleRef
      readonly kind: LifecycleHookKind
      /** The test the hook runs for; `undefined` for a suite's hook. */
      readonly test: LifecycleRef | undefined
    }
  | {
      /**
       * The hook ended. A listener that throws at a `hook-end` that did not fail makes the hook fail
       * with what it threw, and hears a second `hook-end` with that failure; a throw at any other
       * run event (a failed `hook-end` among them) ends the file's run there, with no further hook
       * or event.
       */
      readonly type: 'hook-end'
      readonly hook: LifecycleHookRef
      readonly owner: LifecycleRef
      readonly kind: LifecycleHookKind
      readonly test: LifecycleRef | undefined
      readonly failed: boolean
      /** What the hook threw; meaningful when `failed`. */
      readonly error: unknown
    }
  | { readonly type: 'fn-start'; readonly ref: LifecycleRef }
  | {
      /**
       * The body ended. A listener that throws at the `fn-end` of a body that returned is taken as
       * the body having thrown that: it is the test's failure (reversed for a test expected to
       * fail, as the body's own throw would be), and the listener hears a second `fn-end` with the
       * result. A throw at the `fn-end` of a body that threw ends the file's run.
       */
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
