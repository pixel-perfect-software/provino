// An error from the fake clock carries a stable `code`, so tests and tools needn't read the text.

/** The codes a `TimersError` carries. @public */
export type TimersErrorCode =
  /** A timer was advanced while timers are real, and the policy throws (`notFaked: 'throw'`). */
  | 'TIMERS_NOT_FAKED'
  /** `legacyFakeTimers: true` was asked for; Provino has only the modern implementation. */
  | 'TIMERS_LEGACY_UNSUPPORTED'
  /** A tick mode that is not `manual`, `nextAsync` or `interval`. */
  | 'TIMERS_INVALID_TICK_MODE'

/**
 * An `Error` from the fake clock.
 * @public
 */
export class TimersError extends Error {
  readonly code: TimersErrorCode

  constructor(code: TimersErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
