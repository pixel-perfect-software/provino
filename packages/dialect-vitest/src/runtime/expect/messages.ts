// The words Vitest 5.0.5's `expect` prints for what the engine checks itself (`ExpectMessages`),
// each with the upstream line it comes from. The async and counting policies' words are the
// engine's `policyMessages`, which are Vitest's (`@provino/expect`), and the engine supplies them.
import { policyMessages } from '@provino/expect'
import type { ExpectTableMessages, MatcherCall } from '@provino/types'
import { getType } from '../../vendor/vitest-utils/helpers.ts'
import { chai } from './chai.ts'

/**
 * A custom matcher's result with no usable `message`: Vitest calls `message()` whatever it is
 * (`jest-extend.ts` L109), so V8's TypeError is what a test sees.
 */
const notAFunction = (): never => {
  throw new TypeError('message is not a function')
}

/**
 * Vitest's `ExpectMessages`.
 * @internal
 */
export const vitestMessages: ExpectTableMessages = {
  // Vitest's `expect(value, message)` takes a message (`ExpectPolicy.messageArgument`) and ignores
  // anything after it, so this is never printed.
  tooManyArguments: (): string => 'expect() takes a value and an optional message',
  noMessage: notAFunction,
  // `jest-extend.ts` L107 destructures the result with no check: a result that isn't an object
  // has no `pass` and no `message`, so it fails as a result without a message does.
  invalidResult(result: unknown): string {
    if (result === null || result === undefined) {
      throw new TypeError(`Cannot destructure property 'pass' of 'result' as it is ${result}.`)
    }
    const { message } = result as { readonly message?: unknown }
    if (typeof message !== 'function') return notAFunction()
    return String(message())
  },
  // `jest-expect.ts` L979-L983 and L1041-L1045.
  notAPromise: ({ promise }: MatcherCall, received: unknown): string =>
    `You must provide a Promise to expect() when using .${promise}, not '${typeof received}'.`,
  // `jest-expect.ts` L1004-L1007.
  rejectedInsteadOfResolved: (_call: MatcherCall, reason: unknown): string =>
    `promise rejected "${chai().util.inspect(reason)}" instead of resolving`,
  // `jest-expect.ts` L1064-L1071.
  resolvedInsteadOfRejected: (_call: MatcherCall, value: unknown): string =>
    `promise resolved "${chai().util.inspect(value)}" instead of rejecting`,
  // Vitest registers whatever `expect.extend` is given; a value that is not a function fails
  // when it is called. Provino refuses it at `expect.extend` with these words.
  invalidMatcher: (name: string, value: unknown): string =>
    `expect.extend: \`${name}\` is not a valid matcher. Must be a function, is "${getType(value)}"`,
  // `jest-matcher-utils.ts` L132-L136 (`addCustomEqualityTesters`).
  invalidTesters: (value: unknown): string =>
    `expect.customEqualityTesters: Must be set to an array of Testers. Was given "${getType(value)}"`,
  // `expect.hasAssertions()` takes no argument and reads none (`integrations/chai/index.ts` L91).
  ensureNoExpected: (): void => undefined,
  // `integrations/chai/index.ts` L77-L81.
  assertionCount: (expected: number, actual: number): string =>
    `expected number of assertions to be ${expected}, but got ${actual}`,
  // `integrations/chai/index.ts` L92.
  noAssertions: policyMessages.requiredAssertions,
  // `integrations/chai/index.ts` L69-L71 (`chai.assert.fail`).
  unreachable: (message: string | undefined): string =>
    `expected${message ? ` "${message}" ` : ' '}not to be reached`,
}
