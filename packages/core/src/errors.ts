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
  /** A test declared without a function (`missingTestFn: 'throw'`), or one that runs without one. */
  | 'CORE_MISSING_TEST_FN'
  /** An invalid `.each` table's one failing test (`collect.eachTableError: 'failing-test'`). */
  | 'CORE_INVALID_EACH_TABLE'
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
  /** `runFile` called while another file of the same runtime is collecting or running. */
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
 * The most errors one value serializes to. An error reached twice is written without its cause and
 * errors, but a getter can hand out fresh errors on every read, which only a budget stops.
 */
const MAX_ERRORS = 1000

/** One `serializeError` call's walk: the errors already expanded and the budget used. */
interface Walk {
  readonly seen: Set<object>
  count: number
}

/**
 * Turns anything thrown into plain, clone-safe data: name, message, stack, `code`, the `cause`
 * chain and an aggregate's errors (anything error-like with an `errors` array, so an
 * `AggregateError` from another realm counts), and the `name` and `pass` of a failed assertion's
 * `matcherResult`. A non-error value becomes an error whose message is
 * its string form. Never throws: a field that can't be read (a throwing getter, a revoked proxy)
 * is left out.
 * @public
 */
export function serializeError(value: unknown): SerializedError {
  return serialize(value, 0, { seen: new Set(), count: 0 })
}

function serialize(value: unknown, depth: number, walk: Walk): SerializedError {
  walk.count++
  if (!isErrorLike(value)) return { name: 'Error', message: describe(value) }
  const own = ownFields(value)
  if (depth >= MAX_DEPTH || walk.seen.has(value)) return own
  walk.seen.add(value)
  const cause = read(value, 'cause')
  const errors = aggregated(value)
  return {
    ...own,
    ...(cause === undefined ? {} : { cause: serialize(cause, depth + 1, walk) }),
    ...(errors === undefined ? {} : { errors: serializeAll(errors, depth + 1, walk) }),
  }
}

function serializeAll(errors: readonly unknown[], depth: number, walk: Walk): SerializedError[] {
  const serialized: SerializedError[] = []
  for (const error of errors) {
    if (walk.count >= MAX_ERRORS) break
    serialized.push(serialize(error, depth, walk))
  }
  return serialized
}

function ownFields(value: object): SerializedError {
  const name = read(value, 'name')
  const message = read(value, 'message')
  // A throwing `prepareStackTrace` makes `.stack` throw: the stack is then unknown, which is what
  // the field's absence says.
  const stack = read(value, 'stack')
  const code = read(value, 'code')
  const matcherResult = matcherResultOf(value)
  return {
    name: typeof name === 'string' ? name : 'Error',
    message: typeof message === 'string' ? message : describe(message),
    ...(typeof stack === 'string' ? { stack } : {}),
    ...(typeof code === 'string' ? { code } : {}),
    ...(matcherResult === undefined ? {} : { matcherResult }),
  }
}

/**
 * The `name` and `pass` of the `matcherResult` a failed assertion carries (Jest's
 * `failureDetails[i].matcherResult`), or `undefined` when the error has none or its fields aren't
 * a string and a boolean. The rest of the result can hold any value, so it stays behind.
 */
function matcherResultOf(value: object): SerializedError['matcherResult'] {
  const result = read(value, 'matcherResult')
  if (typeof result !== 'object' || result === null) return undefined
  const name = read(result, 'name')
  const pass = read(result, 'pass')
  return typeof name === 'string' && typeof pass === 'boolean' ? { name, pass } : undefined
}

/**
 * An aggregate's errors, copied into a plain array (up to the budget) so a getter or proxy is read
 * once, and `undefined` when they can't be read.
 */
function aggregated(value: object): readonly unknown[] | undefined {
  try {
    const errors = (value as { errors?: unknown }).errors
    if (!Array.isArray(errors)) return undefined
    const length = Math.min(errors.length, MAX_ERRORS)
    return Array.from({ length }, (_, index): unknown => errors[index])
  } catch {
    return undefined
  }
}

/** One property, or `undefined` when reading it throws (a getter, a proxy trap, a revoked proxy). */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function isErrorLike(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false
  try {
    return value instanceof Error || ('message' in value && 'stack' in value)
  } catch {
    return false
  }
}

const FORMATS: ReadonlyArray<(value: unknown) => string> = [
  String,
  (value) => Object.prototype.toString.call(value),
]

function describe(value: unknown): string {
  if (typeof value === 'string') return value
  for (const format of FORMATS) {
    try {
      return format(value)
    } catch {
      // `String` throws for an object with no `toString`, both for a revoked proxy.
    }
  }
  return `[${typeof value}]`
}
