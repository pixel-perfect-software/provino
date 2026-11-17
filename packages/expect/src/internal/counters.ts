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

/**
 * Whether `state` holds anything an assertion outside a test left: a call, a pass, an expected
 * count, an `expect.hasAssertions()` or a held-back failure.
 * @internal
 */
export function hasCounts(state: MatcherState): boolean {
  return (
    state.assertionCalls !== 0 ||
    state.numPassingAsserts !== 0 ||
    state.expectedAssertionsNumber !== null ||
    state.isExpectingAssertions ||
    state.suppressedErrors.length > 0
  )
}

/**
 * Moves the counters Jest's `extractExpectedAssertionsErrors` and `_addSuppressedErrors` reset from
 * `from` to `to`, and leaves `from` fresh. Jest's one state is reset only when a test ends, so what
 * was counted before reaches the next test that ends (`ExpectPolicy.outsideTestCounts:
 * 'next-test'`). The list of counters is written here once.
 * @internal
 */
export function moveCounters(from: MatcherState, to: MatcherState): void {
  const { expectedAssertionsNumberError, isExpectingAssertionsError } = from
  to.assertionCalls = from.assertionCalls
  to.numPassingAsserts = from.numPassingAsserts
  to.expectedAssertionsNumber = from.expectedAssertionsNumber
  to.isExpectingAssertions = from.isExpectingAssertions
  to.suppressedErrors = from.suppressedErrors
  if (expectedAssertionsNumberError === undefined) delete to.expectedAssertionsNumberError
  else to.expectedAssertionsNumberError = expectedAssertionsNumberError
  if (isExpectingAssertionsError === undefined) delete to.isExpectingAssertionsError
  else to.isExpectingAssertionsError = isExpectingAssertionsError
  const fresh = freshCounters()
  from.assertionCalls = fresh.assertionCalls
  from.numPassingAsserts = fresh.numPassingAsserts
  from.expectedAssertionsNumber = fresh.expectedAssertionsNumber
  from.isExpectingAssertions = fresh.isExpectingAssertions
  from.suppressedErrors = fresh.suppressedErrors
  delete from.expectedAssertionsNumberError
  delete from.isExpectingAssertionsError
}
