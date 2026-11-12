// What `expect` owes a test when its attempt ends (T7.8). The worker registers the returned
// function with core's `onAfterTryTask`, which runs in the attempt's own async context, after
// the last `afterEach` and the teardowns. It returns the errors the attempt gains:
//
// 1. the failures `expect.soft` and `dontThrow()` held back, in the order they happened;
// 2. `expect.assertions(n)` not met, `expect.hasAssertions()` with none made, and, under
//    `ExpectPolicy.requireAssertions`, a test with none (Jest's `extractExpectedAssertionsErrors`
//    and jest-circus' `_addExpectedAssertionErrors`);
// 3. each async assertion still in `pendingAsync` (never awaited), when the worker tracks them.
//
// The counters are not reset, as Jest resets them: every attempt has its own state, and the
// assertion-count sink reads `numPassingAsserts` from it afterwards.
import type { ExpectMessages, ExpectPolicy, MatcherState } from '@provino/types'
import type { StateSource, TestRun } from './state.ts'

/**
 * What the end-of-test check reads from the policy.
 * @public
 */
export interface EndOfTestOptions {
  readonly source: StateSource
  /** The table's messages (`ExpectTable.messages`). */
  readonly messages: ExpectMessages
  /** `ExpectPolicy.requireAssertions`. */
  readonly policy: Pick<ExpectPolicy, 'requireAssertions'>
  /**
   * `CorePolicy.errors.hasAssertionsWhenFailed`, passed in because this package reads only its own
   * slice. `skip` (Jest): on an attempt that already failed, the count errors are left out when
   * `expect.hasAssertions()` was called, and `requireAssertions` adds none. `check`: they are added
   * either way.
   */
  readonly hasAssertionsWhenFailed: 'skip' | 'check'
}

/**
 * The attempt that ended: what core's `TryTaskInfo` carries, without importing core.
 * @public
 */
export interface EndOfTestAttempt extends TestRun {
  readonly test: { readonly id: string }
  /** Whether the attempt had already failed when the check runs. */
  readonly failed: boolean
}

/**
 * Checks one attempt's state and returns its new errors, in the order to report them. Empty when
 * the attempt owes nothing.
 * @public
 */
export type EndOfTest = (attempt: EndOfTestAttempt) => readonly Error[]

/**
 * Builds the end-of-test check.
 * @public
 */
export function createEndOfTest(options: EndOfTestOptions): EndOfTest {
  const { source, messages, hasAssertionsWhenFailed } = options
  const { requireAssertions } = options.policy
  return function endOfTest(attempt: EndOfTestAttempt): readonly Error[] {
    const state = source.stateOf(attempt.test.id, attempt)
    // No `expect` call, `expect.assertions` or soft failure reached this attempt: nothing to count.
    // `requireAssertions` still holds, because zero calls are exactly what it forbids.
    if (state === undefined) {
      return requireAssertions && !(attempt.failed && hasAssertionsWhenFailed === 'skip')
        ? [new Error(messages.requiredAssertions())]
        : []
    }
    const errors = takeSuppressed(state)
    const failed = attempt.failed || errors.length > 0
    errors.push(...countErrors(state, failed))
    errors.push(...takeUnawaited(state))
    return errors
  }

  /** The failures held back, which are the attempt's now. */
  function takeSuppressed(state: MatcherState): Error[] {
    const held = state.suppressedErrors
    state.suppressedErrors = []
    return held
  }

  /** Jest's `_addExpectedAssertionErrors`, plus `requireAssertions`. */
  function countErrors(state: MatcherState, failed: boolean): Error[] {
    const { assertionCalls, expectedAssertionsNumber, isExpectingAssertions } = state
    const errors: Error[] = []
    if (
      typeof expectedAssertionsNumber === 'number' &&
      assertionCalls !== expectedAssertionsNumber
    ) {
      // The error `expect.assertions` made, so its stack is the line that set the count.
      const error = state.expectedAssertionsNumberError ?? new Error()
      error.message = messages.assertionCount(expectedAssertionsNumber, assertionCalls)
      errors.push(error)
    }
    if (isExpectingAssertions && assertionCalls === 0) {
      const error = state.isExpectingAssertionsError ?? new Error()
      error.message = messages.noAssertions()
      errors.push(error)
    }
    // jest-circus: "only show errors from `expect.hasAssertions()` when no other failure has
    // happened". It drops the whole list, whatever else is in it.
    const skipped = failed && hasAssertionsWhenFailed === 'skip'
    if (skipped && isExpectingAssertions) return []
    // A test that failed has a reason already; a required assertion is not another one.
    if (requireAssertions && assertionCalls === 0 && !isExpectingAssertions && !skipped) {
      errors.push(new Error(messages.requiredAssertions()))
    }
    return errors
  }

  /** The async assertions nobody awaited, worded by the table, each with the stack of its call. */
  function takeUnawaited(state: MatcherState): Error[] {
    const errors: Error[] = []
    for (const pending of state.pendingAsync) {
      pending.error.message = messages.unawaited(pending)
      errors.push(pending.error)
    }
    state.pendingAsync.clear()
    return errors
  }
}
