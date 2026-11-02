/**
 * The `report` slice, read by `@provino/reporters` (Tracks 9 and 11).
 * @public
 */
export interface ReportPolicy {
  /** Joins name parts in printed titles. Jest: `' › '`. Vitest: `' > '`. unverified: track-01 L233 */
  readonly displaySeparator: string
  /** Default reporters. Also Track 9's `reporter.default`. Jest: `['default']`. Vitest: `['default']`. unverified: track-01 L234, track-09 L562 */
  readonly defaultReporters: readonly string[]
  /** Bullet before a failure title, or `null` for none. Jest: `' ●  '`. Vitest: n/a. unverified: track-01 L234 */
  readonly failureTitleBullet: string | null
  /** The status word for a skipped test in results. Jest: `pending`. Vitest: `skipped`. unverified: track-11 L522 */
  readonly resultStatusSkipped: 'pending' | 'skipped'
}
