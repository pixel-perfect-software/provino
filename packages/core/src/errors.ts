// Error classes and `serializeError` (Track 5 §Module boundaries → `errors/`). Messages that differ
// between Jest and Vitest are not reproduced here; the dialects own exact text (T5.7, B14).
import type { SerializedError } from '@provino/types'

/**
 * Stable codes for `CoreError`.
 * @public
 */
export type CoreErrorCode =
  /** A task tree feature a later task builds (named in the message). */
  | 'CORE_NOT_IMPLEMENTED'
  /** A `describe` callback returned a promise and the policy forbids it (`asyncDescribe: 'throw'`). */
  | 'CORE_ASYNC_DESCRIBE'
  /** A `describe` callback returned a value (`collect.describeReturnValue: 'error'`). */
  | 'CORE_DESCRIBE_RETURN_VALUE'
  /** A test declared without a function (`missingTestFn: 'throw'`). */
  | 'CORE_MISSING_TEST_FN'
  /** `test.todo(name, fn)` where the policy forbids a body (`collect.todoWithFn: 'throw'`). */
  | 'CORE_TODO_WITH_FN'
  /** `describe`, `test` or a hook called inside a running test (`collect.nestedInTest`). */
  | 'CORE_NESTED_REGISTRATION'
  /** A test or hook registered after collection ended. */
  | 'CORE_LATE_REGISTRATION'
  /** A describe with no tests (`collect.emptyDescribe`). */
  | 'CORE_EMPTY_DESCRIBE'
  /** `.only` used where the policy forbids it (`allowOnly: 'not-in-ci'` on CI). */
  | 'CORE_ONLY_NOT_ALLOWED'
  /** A test or hook ran past its timeout. */
  | 'CORE_TIMEOUT'
  /** A test function returned a value that isn't a promise (`nonPromiseReturn: 'fail'`). */
  | 'CORE_NON_PROMISE_RETURN'
  /** A `.failing`/`.fails` test passed. */
  | 'CORE_EXPECTED_FAILURE'
  /** `onTestFinished`/`onTestFailed` called outside a test, or inside one of those callbacks. */
  | 'CORE_TEST_CALLBACK_CONTEXT'
  /** An argument of the wrong shape (a non-function hook, options in the third position, …). */
  | 'CORE_INVALID_ARGUMENT'
  /** `runFile` called while another file of the same runtime is collecting. */
  | 'CORE_BUSY'

/**
 * An error raised by `@provino/core`, with a stable code.
 * @public
 */
export class CoreError extends Error {
  override readonly name: string = 'CoreError'
  readonly code: CoreErrorCode

  constructor(code: CoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/**
 * An `aroundEach`/`aroundAll` hook returned without calling its inner function, or timed out in its
 * setup phase (Vitest 5.0's meaning). An error the hook throws itself is reported as it is.
 * @public
 */
export class AroundHookSetupError extends Error {
  override readonly name: string = 'AroundHookSetupError'
}

/**
 * An `aroundEach`/`aroundAll` hook timed out after its inner function returned (Vitest 5.0's
 * meaning). An error the hook throws itself is reported as it is.
 * @public
 */
export class AroundHookTeardownError extends Error {
  override readonly name: string = 'AroundHookTeardownError'
}

/**
 * An `aroundEach`/`aroundAll` hook called its inner function more than once.
 * @public
 */
export class AroundHookMultipleCallsError extends Error {
  override readonly name: string = 'AroundHookMultipleCallsError'
}

const MAX_DEPTH = 8

/**
 * Turns anything thrown into plain, clone-safe data: name, message, stack, `code`, the `cause`
 * chain and an `AggregateError`'s errors. A non-error value becomes an error whose message is its
 * string form.
 * @public
 */
export function serializeError(value: unknown): SerializedError {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): SerializedError {
  if (!isErrorLike(value)) {
    return { name: 'Error', message: describe(value) }
  }
  const name = typeof value.name === 'string' ? value.name : 'Error'
  const message = typeof value.message === 'string' ? value.message : describe(value.message)
  const stack = safeStack(value)
  const code = (value as { code?: unknown }).code
  const cause = (value as { cause?: unknown }).cause
  const errors = value instanceof AggregateError ? value.errors : undefined
  const deeper = depth < MAX_DEPTH
  return {
    name,
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(typeof code === 'string' ? { code } : {}),
    ...(cause !== undefined && deeper ? { cause: serialize(cause, depth + 1) } : {}),
    ...(errors !== undefined && deeper
      ? { errors: errors.map((error: unknown) => serialize(error, depth + 1)) }
      : {}),
  }
}

function isErrorLike(value: unknown): value is { name?: unknown; message?: unknown } {
  return (
    value instanceof Error ||
    (typeof value === 'object' && value !== null && 'message' in value && 'stack' in value)
  )
}

function safeStack(value: object): string | undefined {
  try {
    const stack = (value as { stack?: unknown }).stack
    return typeof stack === 'string' ? stack : undefined
  } catch {
    // A frozen prototype or a throwing `prepareStackTrace` makes `.stack` throw; the stack is
    // then unknown, which is what the field's absence says.
    return undefined
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
