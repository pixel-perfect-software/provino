// Calling user functions: the `done` callback under `firstArg: 'done-if-arity'`, generator tests
// under `allowGeneratorFns`, and the `nonPromiseReturn` check for test bodies (T5.7).
//
// `done` follows jest-circus 30.5 `utils.ts` `callAsyncCircusFn` (L196-L312), including its
// words, which are Jest's: this path runs only under `firstArg: 'done-if-arity'`, a Jest policy.
// The values it prints go through the policy's `formatValue` (pretty-format in Jest).
import type { CorePolicy, FormatValue } from '@provino/types'
import { CoreError } from '../errors.ts'
import type { UserFn } from '../internal/model.ts'
import { isThenable } from '../internal/thenable.ts'

/** How a user function is called. */
export interface Invocation {
  readonly fn: UserFn
  /** `fn.length`, read once when the function was registered. */
  readonly arity: number
  readonly thisArg: unknown
  /** Arguments before any `done` callback (`.each` row values). */
  readonly args: readonly unknown[]
  /** Arguments used instead when the function takes no `done` (the context, the suite). */
  readonly contextArgs: readonly unknown[]
  /** Test bodies are checked against `nonPromiseReturn`; hooks may return anything. */
  readonly isTest: boolean
}

/** What a call needs from the executor besides the policy. */
export interface InvokeEnv {
  readonly policy: CorePolicy
  readonly format: FormatValue
  /** Whether the test or hook this call belongs to is over: a `done` after that is late. */
  readonly over: () => boolean
  /** Reports the error of a `done(reason)` that came after the end (`late-done`). */
  readonly late: (error: Error) => void
}

/**
 * Whether the policy gives this function a `done` callback: it declares more parameters than the
 * arguments passed before it (jest-circus: `fn.length > 0`; jest-each's wrapper: `fn.length >
 * row.length`). A generator that declares a parameter takes `done` too, and then never runs.
 */
function takesDone(policy: CorePolicy, arity: number, argCount: number): boolean {
  return policy.firstArg === 'done-if-arity' && arity > argCount
}

/** Calls a user function; the result is its return value, or a promise for `done`. */
export function invoke(env: InvokeEnv, call: Invocation): unknown {
  const { policy } = env
  const { fn, thisArg, args } = call
  if (takesDone(policy, call.arity, args.length)) return invokeWithDone(env, call)
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
    // jest-circus 30.5 `utils.ts` L290-L300.
    throw new CoreError(
      'CORE_NON_PROMISE_RETURN',
      `test functions can only return Promise or undefined.\nReturned value: ${env.format(result)}`,
    )
  }
  return result
}

/** jest-circus's `checkIsError`. */
function isErrorLike(value: unknown): value is Error {
  return (
    typeof value === 'object' &&
    value !== null &&
    Boolean((value as Error).message) &&
    Boolean((value as Error).stack)
  )
}

function invokeWithDone(env: InvokeEnv, call: Invocation): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let seenDone = false
    let settled = false
    let returned: unknown
    const done = (reason?: unknown): void => {
      // The stack is taken here, before the promise tick, as jest-circus does.
      const errorAtDone = new Error()
      Error.captureStackTrace(errorAtDone, done)
      const over = settled || env.over()
      if (!over && seenDone) {
        errorAtDone.message = 'Expected done to be called once, but it was called multiple times.'
        if (reason) errorAtDone.message += ` Reason: ${env.format(reason)}`
        settled = true
        reject(errorAtDone)
        throw errorAtDone
      }
      if (!over) seenDone = true
      // One tick, in case `done` was called synchronously: the function has returned by then.
      void Promise.resolve().then(() => {
        if (returned !== undefined) {
          settled = true
          reject(
            new Error(
              `Test functions cannot both take a 'done' callback and return something. Either use a 'done' callback, or return a promise.\nReturned value: ${env.format(returned)}`,
            ),
          )
          return
        }
        let error: Error
        if (isErrorLike(reason)) {
          error = reason
        } else {
          error = errorAtDone
          error.message = `Failed: ${env.format(reason)}`
        }
        if (over && reason) {
          error.message = `Caught error after test environment was torn down\n\n${error.message}`
          env.late(error)
          return
        }
        settled = true
        if (reason) reject(error)
        else resolve()
      })
    }
    // A throw here rejects the promise, as a throw in the executor of `new Promise` does.
    returned = Reflect.apply(call.fn, call.thisArg, [...call.args, done])
  })
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
