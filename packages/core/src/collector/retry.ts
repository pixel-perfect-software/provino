// A test's `retry` option (T5.10): Vitest 5.0's `retry: number | { count, delay, condition }`,
// read once at registration into a `RetrySpec` the executor uses.
import type { SerializedError } from '@provino/types'

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

/** The `RetrySpec` an option stands for; `undefined` (no option) stays `undefined`. */
export function normalizeRetry(option: RetryOption | undefined): RetrySpec | undefined {
  if (option === undefined) return undefined
  if (typeof option === 'number')
    return { count: retryCount(option), delay: 0, condition: undefined }
  return {
    count: retryCount(option.count),
    delay: retryDelay(option.delay),
    condition: option.condition,
  }
}

/**
 * Whether `condition` lets a failed attempt retry (Vitest's `passesRetryCondition`): with none,
 * every failure does; a `RegExp` is tested against the last error's message.
 */
export function passesCondition(
  condition: RetryCondition | undefined,
  error: SerializedError,
): boolean {
  if (condition === undefined) return true
  if (condition instanceof RegExp) return condition.test(error.message || '')
  return condition(error)
}
