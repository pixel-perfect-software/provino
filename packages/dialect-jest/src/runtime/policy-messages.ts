// The table's messages for policies Jest itself doesn't have (T7.8): a required assertion, an
// unawaited async assertion, `expect.poll`. Provino's own file, not a vendored one. Jest never
// prints these, since its policy leaves the features off; they exist so the neutral engine can run
// the same table under a policy that turns them on, with the wording Vitest 5.0 recorded
// (`fixtures/expect/policies/unawaited-async` and `soft-and-poll`). The Vitest dialect's own table
// (T7.6) owns the Vitest text; this is the placeholder the Jest table answers with until then.
import type { MatcherCall, PendingAssertion } from '@provino/types'

const NOT_AWAITED =
  'was not awaited. This assertion is asynchronous and must be awaited; otherwise,'

/** `expect(actual).resolves.not.toBe(expected)`: the assertion as the "not awaited" text shows it. */
const settledCall = ({ matcherName, isNot, promise }: MatcherCall): string =>
  `expect(actual).${promise}.${isNot ? 'not.' : ''}${matcherName}(expected)`

/** `ExpectPolicy.requireAssertions`: a test made no assertion. */
export const requiredAssertions = (): string => 'expected any number of assertion, but got none'

/** An async assertion the test never awaited. */
export const unawaited = ({ kind, call }: PendingAssertion): string => {
  if (kind === 'settled') {
    const text = settledCall(call)
    return `Promise returned by \`${text}\` ${NOT_AWAITED} it is not guaranteed to complete before the test finishes:\n\nawait ${text}`
  }
  const text = `expect.poll(assertion).${call.isNot ? 'not.' : ''}${call.matcherName}()`
  return `${text} ${NOT_AWAITED} it is not executed to avoid unhandled rejections:\n\nawait ${text}`
}

/** An `expect.poll` stage that did not finish inside the timeout. */
export const pollTimeout = (stage: 'function' | 'assertion'): string =>
  `expect.poll() ${stage === 'function' ? 'function' : 'assertion'} didn't resolve in time.`

/** `expect.poll(...)` read a name polling can't work with. */
export const pollUnsupported = (name: string): string =>
  `expect.poll() is not supported in combination with .${name}`

/** `expect.soft` or `expect.poll` called with no test running. */
export const outsideTest = (name: 'soft' | 'poll'): string =>
  `expect.${name}() must be called inside a test`
