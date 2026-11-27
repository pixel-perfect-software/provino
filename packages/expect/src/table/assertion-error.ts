// The error a failed assertion throws in a native run: the neutral policy's
// `expect.errorShape` is `'assertion-error'`, so the table makes it (`ExpectTable.assertionError`).
import type { MatcherCall, MatcherResult } from '@provino/types'
import type { ExpectErrorCode } from '../errors.ts'

/**
 * A failed assertion of Provino's own table: `name` `AssertionError`, the code
 * `EXPECT_ASSERTION_FAILED`, the matcher's name and the result's `actual` and `expected` (when the
 * matcher gave them). Those three are worker-local: the run's error record (`serializeError`)
 * keeps the name, message, stack, code and cause, so a reporter prints the message, which already
 * holds the difference. Under `.resolves` a promise that rejected has its reason as `cause`. Not
 * exported from `@provino/expect/table`: the table's `assertionError` hook is the contract.
 * @internal
 */
export class ProvinoAssertionError extends Error {
  override readonly name: 'AssertionError' = 'AssertionError'
  readonly code: Extract<ExpectErrorCode, 'EXPECT_ASSERTION_FAILED'> = 'EXPECT_ASSERTION_FAILED'
  readonly matcherName: string
  readonly actual: unknown
  readonly expected: unknown

  constructor(result: MatcherResult, message: string, call: MatcherCall) {
    // `expect(actual, message)`: the label is the message's first line, then a blank line.
    super(
      call.message === undefined ? message : `${call.message}\n\n${message}`,
      call.settlement === 'rejected' ? { cause: result.actual } : undefined,
    )
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
