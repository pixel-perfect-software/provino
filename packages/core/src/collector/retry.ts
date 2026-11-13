// A test's `retry` option (T5.10): Vitest 5.0's `retry: number | { count, delay, condition }`,
// read once at registration into a `RetrySpec` the executor uses.
import type { CorePolicy, SerializedError } from '@provino/types'
import { CoreError } from '../errors.ts'

/**
 * Decides whether a failed attempt is retried: a `RegExp` is tested against the last error's
 * message, a function is called with the error (Vitest's `retry.condition`). Under the policy's
 * `retry.functionCondition: 'ignore-warn'` (Vitest's dialect) a function is not called: Vitest
 * 5.0.5 never calls it, so every failure retries.
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

/**
 * A `retry` option as the executor reads it: whole numbers, and a condition resolved against the
 * policy (`CorePolicy.retry.functionCondition`) into something to ask or something to say.
 */
export interface RetrySpec {
  readonly count: number
  readonly delay: number
  /**
   * Whether a failure retries; `undefined` retries every failure. It keeps no state, so any number
   * of failures and tests can ask it.
   */
  readonly condition: ((error: SerializedError) => boolean) | undefined
  /**
   * `CorePolicy.retry.functionConditionWarning`, when the option's function `condition` is not
   * called (`functionCondition: 'ignore-warn'`): `condition` is then `undefined`, every failure
   * retries, and the executor warns once a file with this text. Otherwise `undefined`.
   */
  readonly ignoredFunction: string | undefined
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
 * Resolves a checked condition against the policy. A function is asked as it is, or, under
 * `ignore-warn`, left unasked with the policy's warning in its place. A `RegExp` is tested against
 * the error's message, through a copy when it has the `g` or `y` flag. Vitest 5.0.5 tests the
 * user's own, whose `lastIndex` then carries from one failure to the next (and from one test to
 * another that shares it), so the same failure is retried once and then not. The copy starts at 0
 * for each failure, a sticky one anchored at the start of the message as written, and the user's
 * RegExp is left alone (D7: an order-dependent result is a bug, fixed in every mode).
 */
function resolveCondition(
  condition: RetryCondition | undefined,
  policy: CorePolicy['retry'],
): Pick<RetrySpec, 'condition' | 'ignoredFunction'> {
  if (condition === undefined) return { condition: undefined, ignoredFunction: undefined }
  if (typeof condition === 'function') {
    return policy.functionCondition === 'call'
      ? { condition, ignoredFunction: undefined }
      : { condition: undefined, ignoredFunction: policy.functionConditionWarning }
  }
  if (!condition.global && !condition.sticky) {
    return { condition: (error) => condition.test(error.message || ''), ignoredFunction: undefined }
  }
  const pattern = new RegExp(condition)
  return {
    condition(error) {
      pattern.lastIndex = 0
      return pattern.test(error.message || '')
    },
    ignoredFunction: undefined,
  }
}

/**
 * The `RetrySpec` an option stands for; `undefined` (no option) stays `undefined`. The option is
 * checked when a test or describe is registered, not when its first failure asks for a retry: a
 * `retry` that is neither a number nor an object, a `count` or `delay` that is not a number, or a
 * `condition` that is not a `RegExp` or a function throws `CORE_INVALID_ARGUMENT` (the caller's
 * types can be wrong: options cross as plain JavaScript).
 */
export function normalizeRetry(
  option: RetryOption | undefined,
  policy: CorePolicy['retry'],
): RetrySpec | undefined {
  const value: unknown = option
  if (value === undefined) return undefined
  if (typeof value === 'number') {
    return { count: retryCount(value), delay: 0, condition: undefined, ignoredFunction: undefined }
  }
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
    ...resolveCondition(condition as RetryCondition | undefined, policy),
  }
}

/**
 * A registration's `retry`: its own option, read once, else the spec its suite passes down. An
 * option that is present is never "no option" (a `null` is a wrong one, and throws).
 */
export function retryOf(
  own: RetryOption | undefined,
  inherited: RetrySpec | undefined,
  policy: CorePolicy['retry'],
): RetrySpec | undefined {
  return own === undefined ? inherited : normalizeRetry(own, policy)
}
