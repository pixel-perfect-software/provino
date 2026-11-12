// T12.10's self-diff: a subject's first reference run against its second and against its third,
// in `exact` mode with console on, under the subject's exclusions and flaky list. The reference
// runner is the candidate too, so everything but run-to-run noise must be identical (the
// normalizer is being calibrated against itself).
import type { NormalizedRun } from '@provino/types'
import { diffRuns, type ExclusionRule, type ParityReport } from '../diff.ts'
import { diffFailures, R2_MAX_EXCLUDED_SHARE } from '../internal/diff-bars.ts'

/** The bars a self-diff must meet; R2's exclusion cap and expiry always apply (DECISIONS D30). */
const BARS = {
  min: 1,
  maxDiffs: 0,
  maxExcluded: R2_MAX_EXCLUDED_SHARE,
  calibration: false,
} as const

/**
 * One comparison of two runs of a subject.
 * @public
 */
export interface SelfDiffPair {
  /** Run numbers on disk: the reference's, then the candidate's. */
  readonly pair: readonly [number, number]
  readonly report: ParityReport
  /** Why it fails; empty when it passes. */
  readonly reasons: readonly string[]
  readonly pass: boolean
}

/**
 * A subject's self-diff.
 * @public
 */
export interface SelfDiff {
  readonly pairs: readonly SelfDiffPair[]
  readonly pass: boolean
}

/**
 * Compares run 1 with each later run. Passes when every comparison has status, message and
 * snapshot parity 1, `suitePass`, no empty comparison, no diff no rule explains (console and
 * stack frames included) and R2's cap on excluded tests.
 * @public
 */
export function selfDiff(
  runs: readonly NormalizedRun[],
  options: {
    readonly exclusions: readonly ExclusionRule[]
    readonly flaky: readonly string[]
    readonly today: string
    /** The number of each run in `runs`, in order (`listRuns`'s). */
    readonly numbers: readonly number[]
  },
): SelfDiff {
  const [first, ...rest] = runs
  const [firstNumber, ...restNumbers] = options.numbers
  if (first === undefined || firstNumber === undefined || rest.length === 0) {
    return { pairs: [], pass: false }
  }
  if (restNumbers.length !== rest.length) {
    throw new Error(`${runs.length} runs but ${options.numbers.length} run numbers`)
  }
  const later = (index: number): number => {
    const n = restNumbers[index]
    if (n === undefined) throw new Error(`no run number for run ${index + 2}`)
    return n
  }
  const pairs = rest.map((candidate, index): SelfDiffPair => {
    const report = diffRuns(
      first,
      candidate,
      {
        messageMode: 'exact',
        compareConsole: true,
        compareTrace: false,
        exclusions: options.exclusions,
        flaky: options.flaky,
      },
      options.today,
    )
    const reasons = diffFailures(report, BARS)
    if (report.messageParity < 1)
      reasons.push(
        `message parity ${report.counts.messageMatched}/${report.counts.failedInBoth} is below 1`,
      )
    if (report.snapshotByteParity < 1)
      reasons.push(
        `snapshot parity ${report.counts.snapshotMatched}/${report.counts.snapshotFiles} is below 1`,
      )
    if (!report.suitePass)
      reasons.push(
        `suite pass: the runs disagree on ${report.counts.files - report.counts.filesMatched} file status(es)`,
      )
    return {
      pair: [firstNumber, later(index)],
      report,
      reasons,
      pass: reasons.length === 0,
    }
  })
  return { pairs, pass: pairs.every((pair) => pair.pass) }
}
