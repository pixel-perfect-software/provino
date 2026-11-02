import { join } from 'node:path'
import type { BenchLabel, BenchRecord, BenchResult, RunEnvironment, RunRef } from '@provino/types'
import { BenchError } from './errors.ts'
import { ratioCi } from './stats.ts'
import { RESULTS_DIR } from './suites.ts'

/**
 * The labels a record may carry (`.claude/rules/benchmarks.md`).
 * @public
 */
export const BENCH_LABELS: readonly BenchLabel[] = ['local', 'desktop', 'pinned']

/**
 * Checks a label typed on the command line.
 * @public
 */
export function parseLabel(value: string): BenchLabel {
  const label = BENCH_LABELS.find((candidate) => candidate === value)
  if (label === undefined) {
    throw new BenchError(
      'BENCH_USAGE',
      `label must be one of ${BENCH_LABELS.join(', ')}; got ${JSON.stringify(value)}`,
    )
  }
  return label
}

/**
 * The machine id used when none is given: `<label>-<platform>-<arch>`. It is never the hostname.
 * @public
 */
export function defaultMachineId(
  label: BenchLabel,
  host: { readonly platform: string; readonly arch: string } = process,
): string {
  return `${label}-${host.platform}-${host.arch}`
}

/**
 * Where a record goes by default: `<dir>/<YYYY-MM-DDTHH-MM-SSZ>-<suite>-<sha7>.json`. The time
 * goes to the second, so a later run never overwrites an earlier record (no run is dropped).
 * @public
 */
export function defaultOutPath(ref: RunRef, suite: string, dir: string = RESULTS_DIR): string {
  const stamp = `${ref.date.slice(0, 19).replaceAll(':', '-')}Z`
  return join(dir, `${stamp}-${suite}-${ref.sha.slice(0, 7)}.json`)
}

/**
 * Assembles a record.
 * @public
 */
export function buildRecord(input: {
  readonly label: BenchLabel
  readonly ref: RunRef
  readonly environment: RunEnvironment
  readonly machineId: string
  readonly results: readonly BenchResult[]
}): BenchRecord {
  return {
    schemaVersion: 1,
    label: input.label,
    ref: input.ref,
    machine: { ...input.environment, id: input.machineId },
    results: input.results,
  }
}

const LABEL_NOTES: Readonly<Record<BenchLabel, string>> = {
  local: 'development signal only, not a result',
  desktop: 'provisional Phase 0-1 numbers from the pinned-core container',
  pinned: 'dedicated bench server',
}

function ms(value: number): string {
  return value.toFixed(1)
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? []
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd(),
  )
}

/**
 * A plain-text summary of a record. Every line starts with the label in brackets. Where a Jest
 * result exists for the same suite and cache state, each other runner gets a median ratio against
 * it with a bootstrap 95% CI.
 * @public
 */
export function formatSummary(record: BenchRecord): string {
  const tag = `[${record.label}]`
  const rows: (readonly string[])[] = [
    [
      'suite',
      'subject',
      'cache',
      'runs',
      'median ms',
      '95% CI ms',
      'IQR ms',
      'min-max ms',
      'cv',
      'cpu user/sys ms',
      'rss MiB',
      'ok',
    ],
  ]
  for (const result of record.results) {
    const { wall } = result
    rows.push([
      result.benchId,
      `${result.subject.runner} ${result.subject.version}`,
      result.cache,
      String(wall.runs),
      ms(wall.medianMs),
      `${ms(wall.ciLowMs)}-${ms(wall.ciHighMs)}`,
      `${ms(wall.q1Ms)}-${ms(wall.q3Ms)}`,
      `${ms(wall.minMs)}-${ms(wall.maxMs)}`,
      wall.cv.toFixed(3),
      result.cpuUserMs === undefined || result.cpuSysMs === undefined
        ? 'n/a'
        : `${result.cpuUserMs.toFixed(0)}/${result.cpuSysMs.toFixed(0)}`,
      result.peakRssMb === undefined ? 'n/a' : result.peakRssMb.toFixed(1),
      result.ok ? 'yes' : 'NO',
    ])
  }
  const out = table(rows).map((line) => `${tag} ${line}`)

  const baselines = record.results.filter((result) => result.subject.runner === 'jest')
  for (const baseline of baselines) {
    for (const result of record.results) {
      if (result.subject.runner === 'jest') continue
      if (result.benchId !== baseline.benchId || result.cache !== baseline.cache) continue
      const label = `${result.benchId} ${result.subject.runner}/jest ${result.cache}`
      if (!result.ok || !baseline.ok) {
        out.push(`${tag} ${label}: no ratio, a run failed`)
        continue
      }
      const ratio = ratioCi(result.wall.samplesMs, baseline.wall.samplesMs)
      out.push(
        `${tag} ${label}: median ratio ${ratio.ratio.toFixed(3)} (95% CI ${ratio.low.toFixed(3)}-${ratio.high.toFixed(3)})`,
      )
    }
  }
  for (const result of record.results) {
    if (!result.ok) {
      out.push(
        `${tag} WARNING: ${result.subject.runner} ${result.cache} had a failing run, so it is not a speed result`,
      )
    }
  }
  out.push(`${tag} label ${record.label}: ${LABEL_NOTES[record.label]}`)
  return out.join('\n')
}
