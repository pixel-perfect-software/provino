import { join } from 'node:path'
import type {
  BenchLabel,
  BenchRecord,
  BenchResult,
  BenchSubject,
  RunEnvironment,
  RunRef,
} from '@provino/types'
import { BenchError } from './errors.ts'
import { DEFAULT_COLD_RUNS, DEFAULT_WARM_RUNS } from './run-bench.ts'
import { ratioCi } from './stats.ts'
import { RESULTS_DIR } from './suites.ts'

/**
 * The labels a record may carry (`.claude/rules/benchmarks.md`).
 * @public
 */
export const BENCH_LABELS: readonly BenchLabel[] = ['local', 'desktop', 'pinned']

/**
 * What a label demands of a record.
 * @public
 */
export interface LabelPolicy {
  /** The fewest warm runs a record with this label may hold. */
  readonly minWarm: number
  /** The fewest cold runs a record with this label may hold. */
  readonly minCold: number
  /** Whether the git working tree must have been clean when the bench started. */
  readonly requireClean: boolean
  /** What the label means; the last line of a summary. */
  readonly note: string
}

/**
 * The one place a label's rules live. `desktop` and `pinned` name numbers that can be quoted, so
 * they need the R5 protocol's run counts and a commit anyone can check out; `local` is a
 * development signal and may be short or dirty (its summary says so).
 * @public
 */
export const LABEL_POLICY: Readonly<Record<BenchLabel, LabelPolicy>> = {
  local: {
    minWarm: 1,
    minCold: 1,
    requireClean: false,
    note: 'development signal only, not a result',
  },
  desktop: {
    minWarm: DEFAULT_WARM_RUNS,
    minCold: DEFAULT_COLD_RUNS,
    requireClean: true,
    note: 'provisional Phase 0-1 numbers from the pinned-core container',
  },
  pinned: {
    minWarm: DEFAULT_WARM_RUNS,
    minCold: DEFAULT_COLD_RUNS,
    requireClean: true,
    note: 'dedicated bench server',
  },
}

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
 * Refuses a label whose policy needs a clean tree (`desktop`, `pinned`) when the tree was dirty,
 * with `BENCH_DIRTY_TREE`: those labels name a commit that anyone can check out, which a dirty tree
 * makes untrue. A `local` record may be dirty; its summary says so.
 * @public
 */
export function requireCleanTree(label: BenchLabel, ref: RunRef): void {
  if (LABEL_POLICY[label].requireClean && ref.dirty) {
    throw new BenchError(
      'BENCH_DIRTY_TREE',
      `refusing a ${label} run: the git working tree has uncommitted changes (git status --porcelain is not empty), so commit ${ref.sha.slice(0, 7)} would not describe the code measured. Commit or stash them, or use --label local`,
    )
  }
}

/**
 * Why a label doesn't accept `runs` timed runs of one cache state, as the sentence saying what it
 * needs; `undefined` if it does.
 * @public
 */
export function runsProblem(
  label: BenchLabel,
  cache: 'warm' | 'cold',
  runs: number,
): string | undefined {
  const { minWarm, minCold } = LABEL_POLICY[label]
  if (runs >= (cache === 'warm' ? minWarm : minCold)) return undefined
  return `a ${label} record needs at least ${minWarm} warm and ${minCold} cold runs (the R5 protocol)`
}

/**
 * Assembles a record, enforcing its label's policy: `BENCH_DIRTY_TREE` when the label needs a clean
 * tree and `ref.dirty` is set, `BENCH_TOO_FEW_RUNS` when a result holds fewer runs than the label
 * allows.
 * @public
 */
export function buildRecord(input: {
  readonly label: BenchLabel
  readonly ref: RunRef
  readonly environment: RunEnvironment
  readonly machineId: string
  readonly results: readonly BenchResult[]
}): BenchRecord {
  requireCleanTree(input.label, input.ref)
  for (const { subject, cache, wall } of input.results) {
    const problem = runsProblem(input.label, cache, wall.runs)
    if (problem !== undefined) {
      throw new BenchError(
        'BENCH_TOO_FEW_RUNS',
        `${problem}; ${subject.runner} ${cache} has ${wall.runs}`,
      )
    }
  }
  return {
    schemaVersion: 1,
    label: input.label,
    ref: input.ref,
    machine: { ...input.environment, id: input.machineId },
    results: input.results,
  }
}

function ms(value: number): string {
  return value.toFixed(1)
}

/**
 * Pads rows of cells into aligned columns.
 * @public
 */
export function table(rows: readonly (readonly string[])[]): string[] {
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
 * A subject's name where a tier matters: ` (registry)` after the runner when its isolation was
 * chosen (Provino's two tiers print differently), and nothing for a runner at its default.
 * @public
 */
export function tierOf(subject: BenchSubject): string {
  return subject.isolation === 'runner-default' ? '' : ` (${subject.isolation})`
}

/**
 * A plain-text summary of a record. Every line starts with the label in brackets. Where a Jest
 * result exists for the same suite and cache state, each other runner gets a median ratio against
 * it with a bootstrap 95% CI. It warns when a result has fewer runs than the R5 protocol, and it
 * names the commit, saying `dirty` when the tree had uncommitted changes.
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
      `${result.subject.runner} ${result.subject.version}${tierOf(result.subject)}`,
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
      const label = `${result.benchId} ${result.subject.runner}${tierOf(result.subject)}/jest ${result.cache}`
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
        `${tag} WARNING: ${result.subject.runner}${tierOf(result.subject)} ${result.cache} had a failing run, so it is not a speed result`,
      )
    }
  }
  const short = record.results.some(
    (result) =>
      result.wall.runs < (result.cache === 'warm' ? DEFAULT_WARM_RUNS : DEFAULT_COLD_RUNS),
  )
  if (short) {
    out.push(
      `${tag} WARNING: fewer runs than the R5 protocol (${DEFAULT_WARM_RUNS} warm, ${DEFAULT_COLD_RUNS} cold); treat these numbers as a smoke test`,
    )
  }
  const commit = record.ref.sha.slice(0, 7)
  if (record.ref.dirty) {
    out.push(`${tag} commit ${commit} (dirty: uncommitted changes when the bench started)`)
    out.push(
      `${tag} WARNING: the working tree was dirty, so commit ${commit} does not describe the code measured`,
    )
  } else {
    out.push(`${tag} commit ${commit} (clean)`)
  }
  out.push(`${tag} label ${record.label}: ${LABEL_POLICY[record.label].note}`)
  return out.join('\n')
}
