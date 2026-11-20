// Provino's own words for the engine's failures (D188). The five policy messages are the engine's.
import { ExpectError } from '@provino/expect'
import type { ExpectTableMessages, MatcherCall } from '@provino/types'
import { show } from './print.ts'

const call = ({ matcherName, isNot, promise }: MatcherCall): string =>
  `expect(received)${promise === '' ? '' : `.${promise}`}${isNot ? '.not' : ''}.${matcherName}()`

/** The table's `messages`. */
export const messages: ExpectTableMessages = {
  tooManyArguments: () => 'expect() takes one value; pass a message through the matcher instead',
  noMessage: () => 'the assertion failed',
  invalidResult: (result) =>
    `a matcher must return { pass, message }, but it returned ${show(result)}`,
  notAPromise: (c, received) =>
    `${call(c)}: the received value must be a promise or a function that returns one, but it is ${show(received)}`,
  rejectedInsteadOfResolved: (c, reason) =>
    `${call(c)}: the promise rejected, but it was expected to resolve\n\nRejected with: ${show(reason)}`,
  resolvedInsteadOfRejected: (c, value) =>
    `${call(c)}: the promise resolved, but it was expected to reject\n\nResolved with: ${show(value)}`,
  invalidMatcher: (name, value) =>
    `expect.extend: ${name} must be a function, but it is ${show(value)}`,
  invalidTesters: (value) =>
    `expect.addEqualityTesters: the argument must be an array of functions, but it is ${show(value)}`,
  ensureNoExpected: (expected, matcherName) => {
    if (expected !== undefined) {
      throw new ExpectError(
        'EXPECT_INVALID_ARGUMENT',
        `${matcherName}() takes no argument, but it got ${show(expected)}`,
      )
    }
  },
  assertionCount: (expected, actual) =>
    `expected ${expected} assertion${expected === 1 ? '' : 's'}, but ${actual} ran`,
  noAssertions: () => 'expected at least one assertion, but none ran',
}
