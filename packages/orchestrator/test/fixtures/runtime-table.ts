// A tiny matcher table for the runtime tests. The orchestrator may not depend on a dialect, so the
// worker loads this by ref where a project would load its dialect's table.
import type { AsymmetricMatcherLike, ExpectTable, Matcher } from '@provino/types'

const toBe = ((received: unknown, expected: unknown) => ({
  pass: Object.is(received, expected),
  message: () => `expected ${String(received)} to be ${String(expected)}`,
})) as unknown as Matcher

const asymmetric = (name: string, inverse: boolean): AsymmetricMatcherLike => ({
  $$typeof: Symbol.for('jest.asymmetricMatcher'),
  asymmetricMatch: () => !inverse,
  toString: () => name,
})

export function testTable(): ExpectTable {
  return {
    matchers: { toBe },
    promiseMatchers: {},
    asymmetric: {},
    asymmetricNot: {},
    utils: {},
    messages: {
      tooManyArguments: () => 'too many arguments',
      noMessage: () => 'no message',
      invalidResult: (result) => `invalid result: ${typeof result}`,
      notAPromise: () => 'not a promise',
      rejectedInsteadOfResolved: () => 'rejected instead of resolved',
      resolvedInsteadOfRejected: () => 'resolved instead of rejected',
      invalidMatcher: (name) => `invalid matcher: ${name}`,
      invalidTesters: () => 'invalid testers',
      ensureNoExpected: () => {},
    },
    customAsymmetric: (name) => (inverse) => asymmetric(name, inverse),
  }
}
