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
  | 'HARNESS_FIXTURE_BAD_NODE_FLAGS'
  | 'HARNESS_FIXTURE_BAD_NODE_MAJORS'
  | 'HARNESS_FIXTURE_BAD_EXPECT_CRASH'
  | 'HARNESS_FIXTURE_BAD_MOCK_CLEANUP'
  | 'HARNESS_FIXTURE_BAD_PACKAGES'
  | 'HARNESS_FIXTURE_BAD_JEST_ESM'
  | 'HARNESS_FIXTURE_BAD_JEST_CONFIG'
  | 'HARNESS_FIXTURE_BAD_CONFIG'
  | 'HARNESS_FIXTURE_BAD_FILES'
  | 'HARNESS_FIXTURE_BAD_RUN'
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
  | 'HARNESS_SIDECAR_INVALID'
  | 'HARNESS_SIDECAR_MISSING'
  | 'HARNESS_EXCLUSIONS_INVALID'
  | 'HARNESS_FLAKY_INVALID'
  | 'HARNESS_EMPTY_COMPARISON'
  | 'HARNESS_SELF_TEST_FAILED'
  | 'HARNESS_CORPUS_MANIFEST_INVALID'
  | 'HARNESS_CORPUS_PIN_FAILED'
  | 'HARNESS_CORPUS_FETCH_FAILED'
  | 'HARNESS_CORPUS_TARBALL_MISMATCH'
  | 'HARNESS_CORPUS_VERIFY_FAILED'
  | 'HARNESS_CORPUS_INSTALL_FAILED'
  | 'HARNESS_CORPUS_NOT_INSTALLED'
  | 'HARNESS_CORPUS_NO_SANDBOX'
  | 'HARNESS_CORPUS_SANDBOX_LEAK'
  | 'HARNESS_CORPUS_RUN_FAILED'
  | 'HARNESS_CORPUS_GATE_INPUT'

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
