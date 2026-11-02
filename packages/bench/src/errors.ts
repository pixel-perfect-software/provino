/**
 * Stable codes for bench errors, so callers and tests assert on the code, not the text.
 * @public
 */
export type BenchErrorCode =
  | 'BENCH_INVALID_SAMPLES'
  | 'BENCH_INVALID_SPEC'
  | 'BENCH_UNSUPPORTED_PLATFORM'
  | 'BENCH_EXEC_FAILED'
  | 'BENCH_PROCESS_TABLE_UNAVAILABLE'
  | 'BENCH_GIT_UNAVAILABLE'
  | 'BENCH_UNKNOWN_SUITE'
  | 'BENCH_RUNNER_NOT_FOUND'
  | 'BENCH_USAGE'
  | 'BENCH_CHECK_FAILED'

/**
 * An error from `@provino/bench`. `cause` carries the underlying failure when there is one.
 * @public
 */
export class BenchError extends Error {
  override readonly name = 'BenchError'
  readonly code: BenchErrorCode

  constructor(code: BenchErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
