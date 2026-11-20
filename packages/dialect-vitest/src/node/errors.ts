// B25c: the Vitest config reader's errors. Each carries a stable code; the text is Vitest's where
// Vitest has one (the line and file are in the comment beside it).

/**
 * Why reading a Vitest config failed.
 * @public
 */
export type VitestConfigErrorCode =
  | 'VITEST_CONFIG_NOT_FOUND'
  | 'VITEST_CONFIG_LOAD_FAILED'
  | 'VITEST_CONFIG_INVALID'
  | 'VITEST_CONFIG_UNSUPPORTED'

/**
 * An error from the Vitest config reader.
 * @public
 */
export class VitestConfigError extends Error {
  readonly code: VitestConfigErrorCode

  constructor(
    code: VitestConfigErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.name = 'VitestConfigError'
    this.code = code
  }
}
