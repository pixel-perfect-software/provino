// The native API's own errors.

/**
 * Stable codes for `ApiError`.
 * @public
 */
export type ApiErrorCode =
  /** A part of the native API a later task builds (named in the message). */
  'API_NOT_BUILT'

/**
 * An error from the native API itself, never from an assertion.
 * @public
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}
