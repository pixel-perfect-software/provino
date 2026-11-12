/**
 * Stable codes for `@provino/env-jsdom` errors, so callers and tests assert on the code, not the
 * text.
 * @public
 */
export type JsdomEnvironmentErrorCode =
  | 'ENV_JSDOM_NOT_INSTALLED'
  | 'ENV_JSDOM_NOT_PREPARED'
  | 'ENV_JSDOM_REALM_UNSUPPORTED'

/**
 * An error from the jsdom environment. A global it cannot restore is not an error: `teardown`
 * reports those (decision D22).
 * @public
 */
export class JsdomEnvironmentError extends Error {
  readonly code: JsdomEnvironmentErrorCode

  constructor(code: JsdomEnvironmentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JsdomEnvironmentError'
    this.code = code
  }
}
