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
