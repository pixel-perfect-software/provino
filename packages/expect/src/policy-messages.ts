// The words for the engine's own async and counting policies (T7.8): a required assertion, an
// unawaited async assertion, `expect.poll`'s timeout and refusals, `expect.soft`/`expect.poll`
// outside a test. One copy, which a dialect's table spreads into its `messages`: the Vitest
// dialect, whose runner has these features, prints exactly these (Vitest 5.0.5's text, recorded
// in `fixtures/expect/policies/unawaited-async` and `soft-and-poll`, from
// `packages/expect/src/utils.ts` L47-L52, `packages/vitest/src/integrations/chai/poll.ts` and
// `index.ts`); a dialect whose runner lacks them (Jest) answers with them for a policy layered on
// it, since its runner has no words of its own.
import type { ExpectMessages, MatcherCall, PendingAssertion } from '@provino/types'

const NOT_AWAITED =
  'was not awaited. This assertion is asynchronous and must be awaited; otherwise,'

/** `expect(actual).resolves.not.toBe(expected)`: the assertion as the "not awaited" text shows it. */
const settledCall = ({ matcherName, isNot, promise }: MatcherCall): string =>
  `expect(actual).${promise}.${isNot ? 'not.' : ''}${matcherName}(expected)`

/**
 * The messages of the engine's own policies, for a table to spread into its `messages`.
 * @public
 */
export const policyMessages: Pick<
  ExpectMessages,
  'requiredAssertions' | 'unawaited' | 'pollTimeout' | 'pollUnsupported' | 'outsideTest'
> = {
  /** `ExpectPolicy.requireAssertions`: a test made no assertion. */
  requiredAssertions: (): string => 'expected any number of assertion, but got none',

  /** An async assertion the test never awaited. */
  unawaited: ({ kind, call }: PendingAssertion): string => {
    if (kind === 'settled') {
      const text = settledCall(call)
      return `Promise returned by \`${text}\` ${NOT_AWAITED} it is not guaranteed to complete before the test finishes:\n\nawait ${text}`
    }
    const text = `expect.poll(assertion).${call.isNot ? 'not.' : ''}${call.matcherName}()`
    return `${text} ${NOT_AWAITED} it is not executed to avoid unhandled rejections:\n\nawait ${text}`
  },

  /** An `expect.poll` stage that did not finish inside the timeout. */
  pollTimeout: (stage: 'function' | 'assertion'): string =>
    `expect.poll() ${stage === 'function' ? 'function' : 'assertion'} didn't resolve in time.`,

  /** `expect.poll(...)` read a name polling can't work with. */
  pollUnsupported: (name: string): string =>
    `expect.poll() is not supported in combination with .${name}`,

  /** `expect.soft` or `expect.poll` called with no test running. */
  outsideTest: (name: 'soft' | 'poll'): string => `expect.${name}() must be called inside a test`,
}
