// Calling user functions: the `done` callback under `firstArg: 'done-if-arity'` (a basic one;
// Jest's exact `done` errors are T5.7), generator tests under `allowGeneratorFns`, and the
// `nonPromiseReturn` check for test bodies.
import type { CorePolicy } from '@provino/types'
import { CoreError } from '../errors.ts'
import type { UserFn } from '../internal/model.ts'
import { isThenable } from '../internal/thenable.ts'

/** How a user function is called. */
export interface Invocation {
  readonly fn: UserFn
  readonly thisArg: unknown
  /** Arguments before any `done` callback (`.each` row values). */
  readonly args: readonly unknown[]
  /** Arguments used instead when the function takes no `done` (the context, the suite). */
  readonly contextArgs: readonly unknown[]
  /** Test bodies are checked against `nonPromiseReturn`; hooks may return anything. */
  readonly isTest: boolean
}

/** Whether the policy gives this function a `done` callback. */
function takesDone(policy: CorePolicy, fn: UserFn, argCount: number): boolean {
  return policy.firstArg === 'done-if-arity' && !isGenerator(fn) && fn.length > argCount
}

/** Calls a user function; the result is its return value, or a promise for `done`. */
export function invoke(policy: CorePolicy, call: Invocation): unknown {
  const { fn, thisArg, args } = call
  if (takesDone(policy, fn, args.length)) return invokeWithDone(call)
  if (isGenerator(fn) && policy.allowGeneratorFns) {
    return drive(Reflect.apply(fn, thisArg, [...args, ...call.contextArgs]) as Generator)
  }
  const result = Reflect.apply(fn, thisArg, [...args, ...call.contextArgs])
  if (
    call.isTest &&
    policy.nonPromiseReturn === 'fail' &&
    result !== undefined &&
    !isThenable(result)
  ) {
    throw new CoreError(
      'CORE_NON_PROMISE_RETURN',
      `A test function can only return a promise or undefined; it returned ${describe(result)}`,
    )
  }
  return result
}

function invokeWithDone(call: Invocation): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let called = false
    let returnedThenable = false
    const settle = (reason: unknown): void => {
      if (reason === undefined || reason === null) resolve()
      else reject(reason instanceof Error ? reason : new Error(`Failed: ${describe(reason)}`))
    }
    const done = (reason?: unknown): void => {
      if (called) {
        reject(new CoreError('CORE_INVALID_ARGUMENT', '`done` was called more than once'))
        return
      }
      called = true
      // Wait until the function has returned: one that also returned a promise fails for that,
      // even when it called `done` first (as jest-circus does).
      queueMicrotask(() => {
        if (!returnedThenable) settle(reason)
      })
    }
    try {
      const result = Reflect.apply(call.fn, call.thisArg, [...call.args, done])
      if (isThenable(result)) {
        returnedThenable = true
        rejectAfter(result, reject)
      }
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Fails a function that took `done` and returned a promise, once that promise settles: observing
 * it keeps its rejection from going unhandled, and the rejection becomes the `cause`.
 */
function rejectAfter(returned: PromiseLike<unknown>, reject: (error: unknown) => void): void {
  const message = 'A function cannot both take a `done` callback and return a promise'
  Promise.resolve(returned).then(
    () => reject(new CoreError('CORE_INVALID_ARGUMENT', message)),
    (error: unknown) => reject(new CoreError('CORE_INVALID_ARGUMENT', message, { cause: error })),
  )
}

function isGenerator(fn: UserFn): boolean {
  const tag = Object.prototype.toString.call(fn)
  return tag === '[object GeneratorFunction]' || tag === '[object AsyncGeneratorFunction]'
}

/** Runs a generator to completion, awaiting each yielded value (co's semantics). */
async function drive(generator: Generator | AsyncGenerator): Promise<unknown> {
  let step = await generator.next()
  while (step.done !== true) {
    try {
      const value: unknown = await step.value
      step = await generator.next(value)
    } catch (error) {
      step = await generator.throw(error)
    }
  }
  return step.value
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return String(value)
  } catch {
    return typeof value
  }
}
