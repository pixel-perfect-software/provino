// The bars a parity report is judged against: `diff`'s flags (T12.5) and the corpus self-diff's
// fixed ones (T12.10) are the same check.
import type { ParityReport } from '../diff.ts'

/**
 * R2's cap: the largest share of a reference's tests that exclusion rules and the flaky list may
 * remove (Track 12 R2; DECISIONS D65). `--max-excluded`'s default, the corpus self-diff's bar and
 * G0's all read it from here.
 * @internal
 */
export const R2_MAX_EXCLUDED_SHARE = 0.02

/**
 * The bars. `maxDiffs` absent means no limit on the diffs no rule explains.
 * @internal
 */
export interface DiffBars {
  /** The lowest status parity that passes. */
  readonly min: number
  /** The most diffs no rule explains that pass. */
  readonly maxDiffs?: number
  /**
   * The largest share of the reference's tests that exclusion rules and the flaky list together
   * may remove (`R2_MAX_EXCLUDED_SHARE`).
   */
  readonly maxExcluded: number
  /** Lifts R2's excluded-share cap (DECISIONS D30). */
  readonly calibration: boolean
}

/**
 * The reference tests exclusion rules removed from T, without the flaky ones (the summary lists
 * the two apart; R2's cap counts both, D65).
 * @internal
 */
export function ruleExcluded(counts: ParityReport['counts']): number {
  return counts.excluded - counts.flaky
}

/**
 * The reasons a report fails the bars; empty when it passes.
 * @internal
 */
export function diffFailures(report: ParityReport, bars: DiffBars): string[] {
  const reasons: string[] = []
  const { counts } = report
  if (counts.comparedTests === 0) {
    reasons.push(
      'HARNESS_EMPTY_COMPARISON: no reference test was compared, so every parity would be a vacuous 1',
    )
  }
  if (report.statusParity < bars.min) {
    reasons.push(
      `status parity ${counts.statusMatched}/${counts.comparedTests} is below --min ${bars.min}`,
    )
  }
  if (bars.maxDiffs !== undefined && report.diffs.length > bars.maxDiffs) {
    reasons.push(
      `${report.diffs.length} diffs no rule explains, more than --max-diffs ${bars.maxDiffs}`,
    )
  }
  // D65: every reference test left out of T, by a rule or as flaky.
  const removed = counts.excluded
  if (
    !bars.calibration &&
    counts.referenceTests > 0 &&
    removed / counts.referenceTests > bars.maxExcluded
  ) {
    reasons.push(
      `exclusion rules and the flaky list exclude ${removed} of ${counts.referenceTests} reference tests, more than --max-excluded ${bars.maxExcluded} (Track 12 R2)`,
    )
  }
  return reasons
}
