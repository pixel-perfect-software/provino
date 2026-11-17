import type { MatcherState } from '@provino/types'

/** The counters a matcher state starts with (Jest's `defaultState`, `jestMatchersObject.ts`). */
type Counters = Pick<
  MatcherState,
  | 'assertionCalls'
  | 'expectedAssertionsNumber'
  | 'isExpectingAssertions'
  | 'numPassingAsserts'
  | 'pendingAsync'
  | 'suppressedErrors'
>

/**
 * Fresh counters: a new state's, and the asymmetric base's when no slot is installed.
 * @internal
 */
export function freshCounters(): Counters {
  return {
    assertionCalls: 0,
    expectedAssertionsNumber: null,
    isExpectingAssertions: false,
    numPassingAsserts: 0,
    pendingAsync: new Set(),
    suppressedErrors: [],
  }
}

/** The state's counters a test's end resets, from `freshCounters()`'s own keys: written once. */
const FRESH = freshCounters()
const COUNTER_KEYS = Object.keys(FRESH).filter((key) => key !== 'pendingAsync')

/**
 * Whether `state` holds anything an assertion outside a test left: a call, a pass, an expected
 * count, an `expect.hasAssertions()` or a held-back failure.
 * @internal
 */
export function hasCounts(state: MatcherState): boolean {
  for (const key of COUNTER_KEYS) {
    const value = state[key]
    if (Array.isArray(value) ? value.length > 0 : value !== FRESH[key as keyof Counters])
      return true
  }
  return false
}

/**
 * Moves the counters Jest's `extractExpectedAssertionsErrors` and `_addSuppressedErrors` reset from
 * `from` to `to`, and leaves `from` fresh. Jest's one state is reset only when a test ends, so what
 * was counted before reaches the next test that ends (`ExpectPolicy.outsideTestCounts:
 * 'next-test'`). The expectation errors travel with their counts.
 * @internal
 */
export function moveCounters(from: MatcherState, to: MatcherState): void {
  const fresh = freshCounters()
  for (const key of COUNTER_KEYS) {
    to[key] = from[key]
    from[key] = fresh[key as keyof Counters]
  }
  for (const key of ERROR_KEYS) {
    if (from[key] === undefined) delete to[key]
    else to[key] = from[key]
    delete from[key]
  }
}

/** The errors made beside `expectedAssertionsNumber` and `isExpectingAssertions`. */
const ERROR_KEYS = ['expectedAssertionsNumberError', 'isExpectingAssertionsError'] as const
