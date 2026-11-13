/**
 * The `report` slice, read by `@provino/reporters` (Tracks 9 and 11).
 * @public
 */
export interface ReportPolicy {
  /** Joins name parts in printed titles. Jest: `' › '`. Vitest: `' > '`. research: track-01 L233 */
  readonly displaySeparator: string
  /** Default reporters. Also Track 9's `reporter.default`. Jest: `['default']`. Vitest: `['default']`. research: track-01 L234, track-09 L562 */
  readonly defaultReporters: readonly string[]
  /** Bullet before a failure title, or `null` for none. Jest: `' ●  '`. Vitest: n/a. research: track-01 L234 */
  readonly failureTitleBullet: string | null
  /**
   * Whether the default reporter lists every test, as `verbose` does, in a run of exactly one test
   * file. Jest: `true` (`runJest` turns `verbose` on for one file unless `--silent` or `verbose:
   * false`, which the reporter's `silent` and `verbose` options carry). Vitest: `false`. Evidence:
   * `cli/report-single-file`, `-silent` and `-verbose-false` (B21c).
   */
  readonly listTestsForSingleFile: boolean
  /** The status word for a skipped test in results. Jest: `pending`. Vitest: `skipped`. research: track-11 L522 */
  readonly resultStatusSkipped: 'pending' | 'skipped'
}
