// The engine's own errors. A failed assertion is not one of these: it is a `MatcherResultError`
// (`expect.ts`), whose text the dialect writes.

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
