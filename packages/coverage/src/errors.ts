/**
 * What a `CoverageError` carries in `code`.
 * @public
 */
export type CoverageErrorCode =
  /** The run asks for something no one has built yet, such as the AST V8 converter (B25). */
  | 'COVERAGE_NOT_IMPLEMENTED'
  /** The coverage config isn't what `SerializedCoverageConfig` or `RunCoverageOptions` describe. */
  | 'COVERAGE_BAD_CONFIG'
  /** The instrumenter couldn't parse or rewrite a file. */
  | 'COVERAGE_INSTRUMENT_FAILED'
  /** A worker's coverage data isn't in the shape its provider reads. */
  | 'COVERAGE_BAD_DATA'
  /** The reports couldn't be written. */
  | 'COVERAGE_REPORT_FAILED'

/**
 * An error from the coverage package. Tests assert on `code`, not on the text.
 * @public
 */
export class CoverageError extends Error {
  override readonly name = 'CoverageError'
  readonly code: CoverageErrorCode

  constructor(code: CoverageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
