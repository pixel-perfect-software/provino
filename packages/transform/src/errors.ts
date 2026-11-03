/**
 * Error codes `@provino/transform` throws. A file's own syntax errors are not thrown: they come
 * back as `TransformDiagnostic`s on the record.
 * @public
 */
export type TransformErrorCode =
  | 'TRANSFORM_OPTION_UNSUPPORTED'
  | 'TRANSFORM_UNSUPPORTED_FILE'
  | 'TRANSFORM_TSCONFIG_INVALID'
  | 'TRANSFORM_RUNNER_FAILED'

/**
 * A transform error with a stable code.
 * @public
 */
export class TransformError extends Error {
  readonly code: TransformErrorCode

  constructor(code: TransformErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TransformError'
    this.code = code
  }
}
