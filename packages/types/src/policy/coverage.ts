/**
 * The `coverage` slice, read by `@provino/coverage` (Track 8). The provider and reporters are
 * chosen by the coordinator: see `OrchestratorPolicy.coverageProvider` and `coverageReporters`.
 * @public
 */
export interface CoveragePolicy {
  /** Which glob threshold a file counts toward. Jest: `first-match`. Vitest: `all-files`. unverified: track-08 L517 */
  readonly thresholdGrouping: 'first-match' | 'all-files'
  /** Whether a glob threshold applies per file or to the glob's total. Jest: `per-file`. Vitest: `aggregate` (unless `perFile`). unverified: track-08 L518 */
  readonly globThresholdScope: 'per-file' | 'aggregate'
  /**
   * Whether files no test loaded are reported once an include list is configured
   * (`collectCoverageFrom` in Jest, `coverage.include` in Vitest). Jest: `true`. Vitest: `true`.
   * unverified: track-08 L521
   */
  readonly includeUntestedByDefault: boolean
  /** Report output directory. Jest: `coverage`. Vitest: `./coverage`. unverified: track-08 L520 */
  readonly reportsDirectory: string
}
