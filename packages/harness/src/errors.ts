/**
 * Stable codes for harness errors, so callers and tests assert on the code, not the text.
 * @public
 */
export type HarnessErrorCode =
  | 'HARNESS_FIXTURE_NOT_FOUND'
  | 'HARNESS_FIXTURE_BAD_JSON'
  | 'HARNESS_FIXTURE_UNKNOWN_KEY'
  | 'HARNESS_FIXTURE_BAD_DESCRIPTION'
  | 'HARNESS_FIXTURE_BAD_RUNNERS'
  | 'HARNESS_FIXTURE_BAD_ENV'
  | 'HARNESS_FIXTURE_BAD_EXPECT_CRASH'
  | 'HARNESS_FIXTURE_NO_TESTS'
  | 'HARNESS_FIXTURE_RUNNER_NOT_LISTED'
  | 'HARNESS_RUNNER_FAILED'
  | 'HARNESS_RUN_INCOMPLETE'
  | 'HARNESS_EXPECTED_CRASH_MISSING'
  | 'HARNESS_EXPECTED_CRASH_MISMATCH'
  | 'HARNESS_TRACE_MULTIPLE_FILES'
  | 'HARNESS_GOLDEN_LEAKS_PATH'
  | 'HARNESS_DUPLICATE_TEST_KEY'
  | 'HARNESS_RESULT_INVALID'
  | 'HARNESS_UNKNOWN_STATUS'
  | 'HARNESS_BAD_DATE'
  | 'HARNESS_USAGE'

/**
 * An error from `@provino/harness`. `path` is the file or field it concerns, when there is one.
 * @public
 */
export class HarnessError extends Error {
  override readonly name = 'HarnessError'
  readonly code: HarnessErrorCode
  readonly path: string | undefined

  constructor(
    code: HarnessErrorCode,
    message: string,
    options?: { readonly path?: string; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.path = options?.path
  }
}
