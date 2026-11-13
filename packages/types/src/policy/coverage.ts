/**
 * The `coverage` slice, read by `@provino/coverage` (Track 8). The provider and reporters are
 * chosen by the coordinator: see `OrchestratorPolicy.coverageProvider` and `coverageReporters`.
 * @public
 */
export interface CoveragePolicy {
  /** Which glob threshold a file counts toward. Jest: `first-match`. Vitest: `all-files`. research: track-08 L517 */
  readonly thresholdGrouping: 'first-match' | 'all-files'
  /** Whether a glob threshold applies per file or to the glob's total. Jest: `per-file`. Vitest: `aggregate` (unless `perFile`). research: track-08 L518 */
  readonly globThresholdScope: 'per-file' | 'aggregate'
  /**
   * Whether files no test loaded are reported once an include list is configured
   * (`collectCoverageFrom` in Jest, `coverage.include` in Vitest). Jest: `true`. Vitest: `true`.
   * research: track-08 L521
   */
  readonly includeUntestedByDefault: boolean
  /** Report output directory. Jest: `coverage`. Vitest: `./coverage`. research: track-08 L520 */
  readonly reportsDirectory: string
  /**
   * How a V8 `ScriptCoverage` becomes Istanbul data. `v8-to-istanbul` is the package Jest uses, with
   * its numbers; `ast` is the faster converter that walks the syntax tree (B25). Jest:
   * `v8-to-istanbul`. Neutral: `ast`, which is refused until B25 builds it. research: track-08 F10
   */
  readonly v8Conversion: 'v8-to-istanbul' | 'ast'
  /**
   * Whether V8 coverage counts calls (`callCount: true`) rather than only whether a range ran.
   * Jest: `true`. Neutral: `false` (it costs memory). research: track-08 F10
   */
  readonly v8HitCounts: boolean
  /** The global the Istanbul instrumenter counts into. Jest: `__coverage__`. research: track-08 F9 */
  readonly istanbulVariable: string
  /**
   * The words of a failed threshold. `{metric}` is a metric name, `{actual}` its percentage or
   * uncovered count, `{threshold}` the limit, `{name}` the group (`global`, a path or a glob) and
   * `{path}` the path or glob of a group with no data.
   * Jest: its three `Jest: …` lines. research: track-08 F11
   */
  readonly thresholdMessages: {
    /** A percentage below its minimum. */
    readonly belowMinimum: string
    /** An uncovered count above its maximum (a negative threshold). */
    readonly aboveMaximumUncovered: string
    /** A path or glob group that no file matched. */
    readonly notFound: string
  }
}
