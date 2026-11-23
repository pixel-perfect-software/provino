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
  | 'TRANSFORM_TRANSFORMER_LOAD_FAILED'
  | 'TRANSFORM_TRANSFORMER_INVALID'

/**
 * What the parser said about a syntax error, and where. Positions are 1-based and in the code the
 * step parsed (the stripped, hoisted text, which is the file's own for plain JavaScript).
 * @public
 */
export interface TransformParseFailure {
  /** The parser's own message, with no file and no position. */
  readonly reason: string
  readonly line: number
  readonly column: number
}

/**
 * A transform error with a stable code.
 * @public
 */
export class TransformError extends Error {
  readonly code: TransformErrorCode
  /**
   * Set when the failure is the parser's report of a syntax error (the module-runner step's, for
   * a file the pipeline passes through unparsed); `undefined` for every other failure.
   */
  readonly parse: TransformParseFailure | undefined

  constructor(
    code: TransformErrorCode,
    message: string,
    options?: ErrorOptions & { readonly parse?: TransformParseFailure },
  ) {
    super(message, options)
    this.name = 'TransformError'
    this.code = code
    this.parse = options?.parse
  }
}
