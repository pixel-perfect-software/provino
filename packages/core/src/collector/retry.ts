// A test's `retry` option (T5.10): Vitest 5.0's `retry: number | { count, delay, condition }`,
// read once at registration into a `RetrySpec` the executor uses.
import type { SerializedError } from '@provino/types'
import { CoreError } from '../errors.ts'

/**
 * Decides whether a failed attempt is retried: a `RegExp` is tested against the last error's
 * message, a function is called with the error (Vitest's `retry.condition`).
 * @public
 */
export type RetryCondition = RegExp | ((error: SerializedError) => boolean)

/**
 * The `retry` option: a count, or the count with what Vitest's `retry` object adds. `delay` is the
 * milliseconds to wait before each retry; `condition` limits which failures retry.
 * @public
 */
export type RetryOption =
  | number
  | {
      readonly count?: number
      readonly delay?: number
      readonly condition?: RetryCondition
    }

/** A `retry` option as the executor reads it: whole numbers, and no optional parts but the condition. */
export interface RetrySpec {
  readonly count: number
  readonly delay: number
  readonly condition: RetryCondition | undefined
}

/** A count as a number of retries: a whole number of 1 or more, else none (so `NaN` and `Infinity` too). */
export function retryCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 0
}

/** A delay in milliseconds: a positive finite number, else none. */
export function retryDelay(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}

/** What a value is, for a message: `null`, `array`, or its `typeof`. */
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

/** Throws for a part of a `retry` option that is present and of the wrong type. */
function invalidRetry(what: string, wanted: string, got: unknown): never {
  throw new CoreError(
    'CORE_INVALID_ARGUMENT',
    `The \`retry\` option's ${what} must be ${wanted}, got ${kindOf(got)}`,
  )
}

/**
 * The `RetrySpec` an option stands for; `undefined` (no option) stays `undefined`. The option is
 * checked when a test or describe is registered, not when its first failure asks for a retry: a
 * `retry` that is neither a number nor an object, a `count` or `delay` that is not a number, or a
 * `condition` that is not a `RegExp` or a function throws `CORE_INVALID_ARGUMENT` (the caller's
 * types can be wrong: options cross as plain JavaScript).
 */
export function normalizeRetry(option: RetryOption | undefined): RetrySpec | undefined {
  const value: unknown = option
  if (value === undefined) return undefined
  if (typeof value === 'number') return { count: retryCount(value), delay: 0, condition: undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidRetry('value', 'a number or an object with `count`, `delay` and `condition`', value)
  }
  const { count, delay, condition } = value as Record<string, unknown>
  if (count !== undefined && typeof count !== 'number') invalidRetry('`count`', 'a number', count)
  if (delay !== undefined && typeof delay !== 'number') invalidRetry('`delay`', 'a number', delay)
  if (
    condition !== undefined &&
    !(condition instanceof RegExp) &&
    typeof condition !== 'function'
  ) {
    invalidRetry('`condition`', 'a RegExp or a function', condition)
  }
  return {
    count: retryCount(count),
    delay: retryDelay(delay),
    condition: condition as RetryCondition | undefined,
  }
}

/**
 * Whether `condition` lets a failed attempt retry (Vitest's `passesRetryCondition`): with none,
 * every failure does; a `RegExp` is tested against the last error's message.
 *
 * A `g` or `y` RegExp is tested through a copy. Vitest 5.0.5 tests the user's own, whose
 * `lastIndex` then carries from one failure to the next (and from one test to another that shares
 * it), so the same failure is retried once and then not. The copy starts at 0 each time, a sticky
 * one anchored at the start of the message as written, and the user's RegExp is left alone
 * (D7: an order-dependent result is a bug, fixed in every mode).
 */
export function passesCondition(
  condition: RetryCondition | undefined,
  error: SerializedError,
): boolean {
  if (condition === undefined) return true
  if (condition instanceof RegExp) {
    const pattern = condition.global || condition.sticky ? new RegExp(condition) : condition
    return pattern.test(error.message || '')
  }
  return condition(error)
}
