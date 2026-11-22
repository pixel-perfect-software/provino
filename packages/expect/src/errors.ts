// The engine's own errors and their codes. A failed assertion is the table's error: a
// `MatcherResultError` (`expect.ts`) under `errorShape: 'matcher-result'`, or the error the
// table's `assertionError` makes under `'assertion-error'` (Provino's own table's carries
// `EXPECT_ASSERTION_FAILED`, `table/assertion-error.ts`); the dialect writes its text.

/**
 * Stable codes for `ExpectError`.
 * @public
 */
export type ExpectErrorCode =
  /** Another `expect` already owns `globalThis[Symbol.for('$$jest-matchers-object')]`. */
  | 'EXPECT_SLOT_TAKEN'
  /** A policy value a later task builds (named in the message). */
  | 'EXPECT_NOT_IMPLEMENTED'
  /** `ExpectPolicy.matcherTable` is `null`: the neutral table has no owner yet. */
  | 'EXPECT_NO_MATCHER_TABLE'
  /** `expect.soft` or `expect.poll` called where no test is running (the table words it). */
  | 'EXPECT_OUTSIDE_TEST'
  /** `expect.poll` read something polling can't work with: `resolves`, `rejects`, `toThrow`, ... */
  | 'EXPECT_POLL_UNSUPPORTED'
  /** `expect.poll` given a callback that isn't a function, or an interval or timeout that isn't a time. */
  | 'EXPECT_INVALID_ARGUMENT'
  /** A failed assertion of Provino's own table (`ProvinoAssertionError`, never an `ExpectError`). */
  | 'EXPECT_ASSERTION_FAILED'

/**
 * An error from the engine itself, never from an assertion.
 * @public
 */
export class ExpectError extends Error {
  readonly code: ExpectErrorCode

  constructor(code: ExpectErrorCode, message: string) {
    super(message)
    this.name = 'ExpectError'
    this.code = code
  }
}
