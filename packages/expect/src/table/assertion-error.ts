// The error a failed assertion throws in a native run: the neutral policy's
// `expect.errorShape` is `'assertion-error'`, so the table makes it (`ExpectTable.assertionError`).
import type { MatcherCall, MatcherResult } from '@provino/types'

/**
 * A failed assertion of Provino's own table: `name` `AssertionError`, the code
 * `EXPECT_ASSERTION_FAILED`, the matcher's name and the result's `actual` and `expected` (when the
 * matcher gave them), so a reporter can show its own difference. Under `.resolves` a promise that
 * rejected has its reason as `cause`.
 * @public
 */
export class ProvinoAssertionError extends Error {
  override readonly name: 'AssertionError' = 'AssertionError'
  readonly code: 'EXPECT_ASSERTION_FAILED' = 'EXPECT_ASSERTION_FAILED'
  readonly matcherName: string
  readonly actual: unknown
  readonly expected: unknown

  constructor(result: MatcherResult, message: string, call: MatcherCall) {
    super(message, call.settlement === 'rejected' ? { cause: result.actual } : undefined)
    this.matcherName = call.matcherName
    this.actual = result.actual
    this.expected = result.expected
  }
}

/**
 * `ExpectTable.assertionError` for Provino's table.
 * @internal
 */
export const assertionError = (result: MatcherResult, message: string, call: MatcherCall): Error =>
  new ProvinoAssertionError(result, message, call)
