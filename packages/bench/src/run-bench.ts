import { rm } from 'node:fs/promises'
import { isAbsolute, parse } from 'node:path'
import type { BenchResult, BenchSubject } from '@provino/types'
import { BenchError } from './errors.ts'
import { type ExecOutcome, type ExecProcess, execProcess } from './exec.ts'
import { max, median, wallStats } from './stats.ts'

/**
 * Warm timed runs per subject (Track 12 R5).
 * @public
 */
export const DEFAULT_WARM_RUNS = 10

/**
 * Cold timed runs per subject (Track 12 R5).
 * @public
 */
export const DEFAULT_COLD_RUNS = 5

/**
 * Which tool owns a cache directory: Jest's `cacheDirectory`, Vite's `cacheDir`, Provino's
 * transform cache, or the Node (V8) compile cache.
 * @public
 */
export type CacheKind = 'jest' | 'vite' | 'provino' | 'node-compile'

/**
 * A cache directory the subject writes. A cold run deletes it first.
 * @public
 */
export interface CacheDir {
  readonly kind: CacheKind
  /** Absolute. */
  readonly path: string
}

/**
 * One subject to run: how to start it, where, and which caches make a run cold.
 * @public
 */
export interface BenchSubjectSpec {
  readonly subject: BenchSubject
  /** The command and its arguments. No shell parsing happens. */
  readonly argv: readonly string[]
  readonly cwd: string
  /** Added on top of the bench process's environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Deleted before each cold run. At least one is needed. */
  readonly caches: readonly CacheDir[]
}

/**
 * Which part of the protocol a run belongs to. Only `warm` and `cold` runs are timed results; the
 * `warm-up` run is discarded.
 * @public
 */
export type RunPhase = 'warm-up' | 'warm' | 'cold'

/**
 * Reported after each run, for progress output.
 * @public
 */
export interface RunEvent {
  readonly benchId: string
  readonly subject: BenchSubject
  readonly phase: RunPhase
  /** 1-based round within the phase. */
  readonly round: number
  readonly rounds: number
  readonly outcome: ExecOutcome
}

/**
 * What to benchmark.
 * @public
 */
export interface BenchSpec {
  /** The suite, e.g. `app-500`. */
  readonly benchId: string
  readonly subjects: readonly BenchSubjectSpec[]
  /** Default `DEFAULT_WARM_RUNS`. */
  readonly warmRuns?: number
  /** Default `DEFAULT_COLD_RUNS`. */
  readonly coldRuns?: number
  /** The process runner. Default `execProcess`; tests pass a fake. */
  readonly exec?: ExecProcess
  readonly onRun?: (event: RunEvent) => void
}

function invalid(message: string): BenchError {
  return new BenchError('BENCH_INVALID_SPEC', message)
}

function positiveCount(value: number | undefined, fallback: number, name: string): number {
  const count = value ?? fallback
  if (!Number.isInteger(count) || count < 1) throw invalid(`${name} must be a positive integer`)
  return count
}

function validate(spec: BenchSpec): { warmRuns: number; coldRuns: number } {
  if (spec.subjects.length === 0) throw invalid('a bench needs at least one subject')
  for (const { subject, caches, argv } of spec.subjects) {
    const name = `${subject.runner} ${subject.version}`
    if (argv.length === 0) throw invalid(`${name} has an empty argv`)
    if (caches.length === 0) {
      throw invalid(`${name} has no cache dirs, so its cold runs would not be cold`)
    }
    for (const { path } of caches) {
      // The runner deletes these recursively, so refuse anything that could be a whole disk.
      if (!isAbsolute(path) || parse(path).root === path) {
        throw invalid(
          `${name} cache dir ${JSON.stringify(path)} must be an absolute, non-root path`,
        )
      }
    }
  }
  return {
    warmRuns: positiveCount(spec.warmRuns, DEFAULT_WARM_RUNS, 'warmRuns'),
    coldRuns: positiveCount(spec.coldRuns, DEFAULT_COLD_RUNS, 'coldRuns'),
  }
}

function optionalNumber(
  outcomes: readonly ExecOutcome[],
  pick: (outcome: ExecOutcome) => number | undefined,
  reduce: (values: readonly number[]) => number,
): number | undefined {
  const values = outcomes.map(pick).filter((value): value is number => value !== undefined)
  return values.length === 0 ? undefined : reduce(values)
}

// Wall statistics cover every run. CPU is the median across runs, so it describes the typical
// run like the wall median does; RSS is the maximum, because it is a peak.
function summarize(
  benchId: string,
  subject: BenchSubject,
  cache: 'cold' | 'warm',
  outcomes: readonly ExecOutcome[],
): BenchResult {
  const cpuUserMs = optionalNumber(outcomes, (o) => o.cpuUserMs, median)
  const cpuSysMs = optionalNumber(outcomes, (o) => o.cpuSysMs, median)
  const peakRssMb = optionalNumber(outcomes, (o) => o.peakRssMb, max)
  return {
    benchId,
    subject,
    cache,
    wall: wallStats(outcomes.map((outcome) => outcome.wallMs)),
    ...(peakRssMb === undefined ? {} : { peakRssMb }),
    ...(cpuUserMs === undefined ? {} : { cpuUserMs }),
    ...(cpuSysMs === undefined ? {} : { cpuSysMs }),
    ok: outcomes.every((outcome) => outcome.exitCode === 0),
  }
}

/**
 * Runs the Track 12 R5 protocol. For each subject: one discarded warm-up run; then `warmRuns`
 * rounds with the subjects interleaved (A B A B ...) and their caches kept; then `coldRuns` rounds
 * interleaved, where each subject's cache dirs are deleted right before its own run. Every timed
 * run is kept, whether it passed or not: nothing is dropped or re-run, and `ok` is false if any
 * timed run exited non-zero. Returns each subject's warm result and then its cold one.
 * @public
 */
export async function runBench(spec: BenchSpec): Promise<readonly BenchResult[]> {
  const { warmRuns, coldRuns } = validate(spec)
  const exec = spec.exec ?? execProcess
  const warm = spec.subjects.map((): ExecOutcome[] => [])
  const cold = spec.subjects.map((): ExecOutcome[] => [])

  const run = async (
    { subject, argv, cwd, env }: BenchSubjectSpec,
    phase: RunPhase,
    round: number,
    rounds: number,
  ): Promise<ExecOutcome> => {
    const outcome = await exec({ argv, cwd, env: env ?? {} })
    spec.onRun?.({ benchId: spec.benchId, subject, phase, round, rounds, outcome })
    return outcome
  }

  for (const subject of spec.subjects) await run(subject, 'warm-up', 1, 1)

  for (let round = 1; round <= warmRuns; round++) {
    for (const [index, subject] of spec.subjects.entries()) {
      warm[index]?.push(await run(subject, 'warm', round, warmRuns))
    }
  }

  for (let round = 1; round <= coldRuns; round++) {
    for (const [index, subject] of spec.subjects.entries()) {
      await Promise.all(
        subject.caches.map(({ path }) => rm(path, { recursive: true, force: true })),
      )
      cold[index]?.push(await run(subject, 'cold', round, coldRuns))
    }
  }

  return spec.subjects.flatMap(({ subject }, index) => [
    summarize(spec.benchId, subject, 'warm', warm[index] ?? []),
    summarize(spec.benchId, subject, 'cold', cold[index] ?? []),
  ])
}
