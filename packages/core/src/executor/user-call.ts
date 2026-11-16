// The one frame through which core calls a function a file registered: a describe body, a test, a
// hook, a teardown a `beforeEach` returned, a test callback, a generator test's steps.
//
// On every stack the function's synchronous part captures, it is the first of Provino's frames
// outward from the code the file registered, and it has a name of its own (`USER_CALL_FRAME`), so a
// stack reader can tell what a test or hook ran from what Provino's own code did. A path can't: the
// `provino` bundle inlines Provino's packages into a few files. The function is a method with a
// computed name, so no bundler renames it, and it adds one call to each user call (V8 inlines it).
import type { UserFn } from '../internal/model.ts'

/**
 * The name of the frame through which core calls a function a file registered (a describe body, a
 * test, a hook, a teardown, a test callback): the first of Provino's frames outward from that
 * function on any stack its synchronous part captures. Not on a stack after an `await` in it.
 * @public
 */
export const USER_CALL_FRAME = 'provinoUserCall'

/** Calls `fn` with `thisArg` and `args` through the frame `USER_CALL_FRAME` names. */
export const callUser: (fn: UserFn, thisArg: unknown, args: readonly unknown[]) => unknown = {
  [USER_CALL_FRAME](fn: UserFn, thisArg: unknown, args: readonly unknown[]): unknown {
    return Reflect.apply(fn, thisArg, args)
  },
}[USER_CALL_FRAME] as (fn: UserFn, thisArg: unknown, args: readonly unknown[]) => unknown
