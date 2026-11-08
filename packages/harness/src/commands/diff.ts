// `provino-harness diff` (Track 12 T12.5): two NormalizedRun files, compared and judged.
import type { NormalizedRun } from '@provino/types'
import { DIFF_KINDS, diffRuns, type ExclusionRule, type ParityReport } from '../diff.ts'
import { HarnessError } from '../errors.ts'
import { parseExclusions, parseFlaky } from '../exclusions.ts'
import type { DiffCommand } from '../internal/cli-args.ts'
import { parseNormalizedRun } from '../parse-normalized-run.ts'
import { type CommandIo, failureText, readText } from './io.ts'

/** Both runs, the exclusions with R2's limits and the flaky list. A bad input is a `HarnessError`. */
async function readInputs(
  command: DiffCommand,
  today: string,
): Promise<{
  readonly ref: NormalizedRun
  readonly cand: NormalizedRun
  readonly exclusions: readonly ExclusionRule[]
  readonly flaky: readonly string[]
}> {
  const ref = parseNormalizedRun(await readText(command.ref, 'reference run'), command.ref)
  const cand = parseNormalizedRun(await readText(command.cand, 'candidate run'), command.cand)
  const exclusions =
    command.exclusions === undefined
      ? []
      : parseExclusions(await readText(command.exclusions, 'exclusions'), command.exclusions, {
          today,
          calibration: command.calibration,
        })
  const flaky =
    command.flaky === undefined
      ? []
      : parseFlaky(await readText(command.flaky, 'flaky list'), command.flaky)
  return { ref, cand, exclusions, flaky }
}

/** The reference tests exclusion rules removed from T (R2's cap counts these, not flaky ones). */
function ruleExcluded(counts: ParityReport['counts']): number {
  return counts.excluded - counts.flaky
}

/** The reasons a report fails the command's bars; empty when it passes. */
function failures(report: ParityReport, command: DiffCommand): string[] {
  const reasons: string[] = []
  const { counts } = report
  if (counts.comparedTests === 0) {
    reasons.push(
      'HARNESS_EMPTY_COMPARISON: no reference test was compared, so every parity would be a vacuous 1',
    )
  }
  if (report.statusParity < command.min) {
    reasons.push(
      `status parity ${counts.statusMatched}/${counts.comparedTests} is below --min ${command.min}`,
    )
  }
  if (command.maxDiffs !== undefined && report.diffs.length > command.maxDiffs) {
    reasons.push(
      `${report.diffs.length} diffs no rule explains, more than --max-diffs ${command.maxDiffs}`,
    )
  }
  const removed = ruleExcluded(counts)
  if (
    !command.calibration &&
    counts.referenceTests > 0 &&
    removed / counts.referenceTests > command.maxExcluded
  ) {
    reasons.push(
      `exclusion rules remove ${removed} of ${counts.referenceTests} reference tests, more than --max-excluded ${command.maxExcluded} (Track 12 R2)`,
    )
  }
  return reasons
}

function percent(matched: number, total: number): string {
  return total === 0 ? '   n/a' : `${((matched / total) * 100).toFixed(1).padStart(5)}%`
}

function tally(items: readonly string[]): string {
  if (items.length === 0) return '(none)'
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts].map(([item, n]) => `${item} ${n}`).join(', ')
}

/** The summary a person reads: who, the four parities with their counts, and what is left. */
function summaryTable(report: ParityReport, reasons: readonly string[]): string {
  const { counts } = report
  const who = (side: ParityReport['reference']): string =>
    `${side.runner} ${side.runnerVersion} (${side.suite})`
  const kinds = report.diffs
    .map((diff) => diff.kind)
    .toSorted((a, b) => DIFF_KINDS.indexOf(a) - DIFF_KINDS.indexOf(b))
  const rows: [string, string][] = [
    ['reference', who(report.reference)],
    ['candidate', who(report.candidate)],
    ['mode', report.messageMode],
    ['', ''],
    [
      'status parity',
      `${percent(counts.statusMatched, counts.comparedTests)}  ${counts.statusMatched}/${counts.comparedTests}`,
    ],
    [
      'message parity',
      `${percent(counts.messageMatched, counts.failedInBoth)}  ${counts.messageMatched}/${counts.failedInBoth}`,
    ],
    [
      'snapshot parity',
      `${percent(counts.snapshotMatched, counts.snapshotFiles)}  ${counts.snapshotMatched}/${counts.snapshotFiles}`,
    ],
    [
      'suite pass',
      `${report.suitePass ? 'yes' : 'no'}  ${counts.filesMatched}/${counts.files} files`,
    ],
    [
      'excluded',
      `${ruleExcluded(counts)} by rules, ${counts.flaky} flaky, of ${counts.referenceTests} tests`,
    ],
    ['candidate only', `${counts.candidateOnlyTests} tests`],
    ['', ''],
    ['diffs', tally(kinds)],
    ['excluded diffs', tally(report.excluded.map((diff) => diff.ruleId))],
    [
      'expired rules',
      report.expiredExclusions.map((rule) => `${rule.id} (${rule.expires})`).join(', ') || '(none)',
    ],
  ]
  const width = Math.max(...rows.map(([label]) => label.length))
  const lines = rows.map(([label, value]) =>
    label === '' ? '' : `${label.padEnd(width)}  ${value}`,
  )
  lines.push(
    '',
    reasons.length === 0 ? 'PASS' : `FAIL\n${reasons.map((r) => `  - ${r}`).join('\n')}`,
  )
  return `${lines.join('\n')}\n`
}

/**
 * Runs `diff`: reads both runs (`parseNormalizedRun`), the exclusions with R2's limits and the
 * flaky list, compares them with `diffRuns`, prints the `ParityReport` as JSON to `out` and the
 * summary to `err`. Exit 0 when the report passes every bar, 1 when it doesn't, 2 when an input
 * can't be read.
 * @internal
 */
export async function diffCommand(command: DiffCommand, io: CommandIo): Promise<number> {
  const today = command.today ?? new Date().toISOString().slice(0, 10)
  let inputs: Awaited<ReturnType<typeof readInputs>>
  try {
    inputs = await readInputs(command, today)
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error
    io.err(`${failureText(error)}\n`)
    return 2
  }
  const report = diffRuns(
    inputs.ref,
    inputs.cand,
    {
      messageMode: command.mode,
      compareConsole: command.console,
      compareTrace: false,
      exclusions: inputs.exclusions,
      flaky: inputs.flaky,
    },
    today,
  )
  const reasons = failures(report, command)
  io.out(`${JSON.stringify(report, null, 2)}\n`)
  io.err(summaryTable(report, reasons))
  return reasons.length === 0 ? 0 : 1
}
