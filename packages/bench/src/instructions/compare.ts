// The guard's judgement: each leg's instruction count against the baseline's (`main`'s record),
// flagged when the rise reaches the leg's threshold. Pure: it runs nothing and reads no file.
import type { BenchRecord } from '@provino/types'
import { BenchError } from '../errors.ts'
import { pastLimit } from '../internal/limits.ts'
import type { Leg } from './legs.ts'

/**
 * How one leg compares.
 * - `regressed`: the count rose by the leg's threshold or more (or the rise is not a number).
 * - `within`: below the threshold; a fall is within too.
 * - `no-baseline`: the baseline has no count for the leg, so nothing is compared.
 * - `not-measured`: this run has no count for the leg (cachegrind off, or the leg failed).
 * @public
 */
export type LegStatus = 'regressed' | 'within' | 'no-baseline' | 'not-measured'

/**
 * One leg against its baseline.
 * @public
 */
export interface LegComparison {
  readonly leg: Leg
  readonly current: number | undefined
  readonly baseline: number | undefined
  /** `(current - baseline) / baseline` in percent, when both are known. */
  readonly deltaPercent: number | undefined
  readonly status: LegStatus
}

/**
 * Compares one count with its baseline. A rise of exactly the threshold is flagged: T12.13
 * "comments at +1.5%". Written `!(delta < threshold)` so a delta that is not a number is flagged,
 * never passed.
 * @public
 */
export function compareLeg(
  leg: Leg,
  current: number | undefined,
  baseline: number | undefined,
): LegComparison {
  if (current === undefined) {
    return { leg, current, baseline, deltaPercent: undefined, status: 'not-measured' }
  }
  if (baseline === undefined) {
    return { leg, current, baseline, deltaPercent: undefined, status: 'no-baseline' }
  }
  const deltaPercent = ((current - baseline) / baseline) * 100
  const status: LegStatus = !(deltaPercent < leg.thresholdPercent) ? 'regressed' : 'within'
  return { leg, current, baseline, deltaPercent, status }
}

/**
 * The benchId a leg's result carries in a record.
 * @public
 */
export function benchIdOf(leg: Leg): string {
  return `instructions/${leg.id}`
}

/**
 * Each leg's instruction count in `record`, by leg id. A result without a count, or one whose run
 * failed (`ok: false`), is left out: it is no baseline.
 * @public
 */
export function countsOf(record: BenchRecord): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const result of record.results) {
    if (!result.benchId.startsWith('instructions/')) continue
    if (!result.ok || result.instructions === undefined) continue
    counts.set(result.benchId.slice('instructions/'.length), result.instructions)
  }
  return counts
}

/**
 * Checks that a baseline can be compared with this run: the same Node version and architecture
 * (instruction counts differ between both). Throws `BENCH_BASELINE_INVALID` naming the difference.
 * @public
 */
export function assertComparable(
  baseline: BenchRecord,
  current: { readonly node: string; readonly arch: string; readonly os: string },
): void {
  const { node, arch, os } = baseline.machine
  const differences = [
    node === current.node ? undefined : `Node ${node} against ${current.node}`,
    arch === current.arch ? undefined : `${arch} against ${current.arch}`,
    os === current.os ? undefined : `${os} against ${current.os}`,
  ].filter((difference) => difference !== undefined)
  if (differences.length > 0) {
    throw new BenchError(
      'BENCH_BASELINE_INVALID',
      `the baseline was counted on another machine (${differences.join(', ')}); instruction counts compare only on the same Node, OS and architecture`,
    )
  }
}

/**
 * Whether any leg regressed.
 * @public
 */
export function anyRegressed(comparisons: readonly LegComparison[]): boolean {
  return comparisons.some((comparison) => comparison.status === 'regressed')
}

/**
 * A change in percent, signed, with two decimals (`+2.00%`, `-0.31%`), or more where two would
 * print the threshold itself for a value that is not it: +1.4996% is `+1.4996%`, never `+1.50%`,
 * which would read as flagged (the bench's rule: text never rounds across a limit).
 * @public
 */
export function signedPercent(value: number, threshold?: number): string {
  const text = threshold === undefined ? value.toFixed(2) : pastLimit(value, threshold, 2)
  return `${value >= 0 ? '+' : ''}${text}%`
}

/**
 * A count in millions with three decimals: `1234.568 M`.
 * @public
 */
export function millions(value: number): string {
  return `${(value / 1e6).toFixed(3)} M`
}

/**
 * The summary table, as Markdown (it reads as text in a terminal and renders in a CI job
 * summary): one row per leg, then a line per flagged leg.
 * @public
 */
export function comparisonLines(comparisons: readonly LegComparison[]): string[] {
  const lines = [
    '| leg | task | instructions | baseline | change | flag at | status |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const { leg, current, baseline, deltaPercent, status } of comparisons) {
    lines.push(
      `| ${leg.id} | ${leg.task} | ${current === undefined ? '—' : millions(current)} | ${baseline === undefined ? '—' : millions(baseline)} | ${deltaPercent === undefined ? '—' : signedPercent(deltaPercent, leg.thresholdPercent)} | +${leg.thresholdPercent}% | ${status === 'regressed' ? '**REGRESSED**' : status} |`,
    )
  }
  for (const { leg, deltaPercent, status } of comparisons) {
    if (status !== 'regressed') continue
    lines.push(
      `REGRESSED ${leg.id} (${leg.task}): ${deltaPercent === undefined ? 'not a number' : signedPercent(deltaPercent, leg.thresholdPercent)} instructions, at or over the +${leg.thresholdPercent}% line`,
    )
  }
  return lines
}
