import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { BenchResult, BenchSubject } from '@provino/types'
import { BenchError } from './errors.ts'
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type ExecOutcome,
  type ExecProcess,
  execProcess,
  MAX_RUN_TIMEOUT_MS,
} from './exec.ts'
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
 * The exit code recorded for a run that could not be started at all (spawn failed): 126, the
 * shell's "found but could not execute".
 * @public
 */
export const SPAWN_FAILED_EXIT_CODE = 126

/**
 * A cache dir needs at least this many path segments below the filesystem root, so `/`, `/tmp` and
 * `/home/me` can never be one.
 * @public
 */
export const MIN_CACHE_DIR_DEPTH = 3

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
  /**
   * How long one run may take before it is killed and kept as a failed run (exit 124). Default
   * `DEFAULT_RUN_TIMEOUT_MS`.
   */
  readonly timeoutMs?: number
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

function isInside(inner: string, outer: string): boolean {
  const path = relative(outer, inner)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/**
 * Why a cache dir must not be deleted recursively, or `undefined` if it may be. The dir has to be
 * absolute with no `..` segment, at least `MIN_CACHE_DIR_DEPTH` levels below the root, and neither
 * the subject's working directory, an ancestor of it, nor the home directory or an ancestor of it.
 * `home` is a test seam; it defaults to `os.homedir()`.
 * @public
 */
export function cacheDirProblem(
  path: string,
  context: { readonly cwd: string; readonly home?: string },
): string | undefined {
  if (!isAbsolute(path)) return 'must be an absolute path'
  if (path.split(/[\\/]/).includes('..')) return 'must not contain a .. segment'
  const resolved = resolve(path)
  const depth = relative(parse(resolved).root, resolved).split(sep).filter(Boolean).length
  if (depth < MIN_CACHE_DIR_DEPTH) {
    return `is too close to the filesystem root (it needs at least ${MIN_CACHE_DIR_DEPTH} levels)`
  }
  if (isInside(resolve(context.cwd), resolved)) {
    return 'is the subject’s working directory or one of its ancestors'
  }
  if (isInside(resolve(context.home ?? homedir()), resolved)) {
    return 'is the home directory or one of its ancestors'
  }
  return undefined
}

function validate(spec: BenchSpec): { warmRuns: number; coldRuns: number; timeoutMs: number } {
  if (spec.subjects.length === 0) throw invalid('a bench needs at least one subject')
  for (const { subject, caches, argv, cwd } of spec.subjects) {
    const name = `${subject.runner} ${subject.version}`
    if (argv.length === 0) throw invalid(`${name} has an empty argv`)
    if (caches.length === 0) {
      throw invalid(`${name} has no cache dirs, so its cold runs would not be cold`)
    }
    for (const { path } of caches) {
      // The runner deletes these recursively, so refuse anything that could be a project or a disk.
      const problem = cacheDirProblem(path, { cwd })
      if (problem !== undefined) {
        throw invalid(`${name} cache dir ${JSON.stringify(path)} ${problem}`)
      }
    }
  }
  const timeoutMs = spec.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RUN_TIMEOUT_MS) {
    throw invalid(
      `timeoutMs must be a whole number of milliseconds from 1 to ${MAX_RUN_TIMEOUT_MS}`,
    )
  }
  return {
    warmRuns: positiveCount(spec.warmRuns, DEFAULT_WARM_RUNS, 'warmRuns'),
    coldRuns: positiveCount(spec.coldRuns, DEFAULT_COLD_RUNS, 'coldRuns'),
    timeoutMs,
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

async function clearCache(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (cause) {
    throw new BenchError(
      'BENCH_CACHE_CLEAR_FAILED',
      `could not delete the cache dir ${path} before a cold run`,
      { cause },
    )
  }
}

/**
 * Runs the Track 12 R5 protocol. For each subject: one discarded warm-up run; then `warmRuns`
 * rounds with the subjects interleaved (A B A B ...) and their caches kept; then `coldRuns` rounds
 * interleaved, where each subject's cache dirs are deleted right before its own run. Every timed
 * run is kept, whether it passed or not: nothing is dropped or re-run, and `ok` is false if any
 * timed run exited non-zero. A run that can't be started (`BENCH_EXEC_FAILED`) is kept as a failed
 * run with exit `SPAWN_FAILED_EXIT_CODE` and a warning, and a run that outlasts `timeoutMs` is
 * killed and kept as exit 124, so one bad run never costs the session. A cache dir that can't be
 * deleted does throw (`BENCH_CACHE_CLEAR_FAILED`): the cold run after it would not be cold.
 * Returns each subject's warm result and then its cold one.
 * @public
 */
export async function runBench(spec: BenchSpec): Promise<readonly BenchResult[]> {
  const { warmRuns, coldRuns, timeoutMs } = validate(spec)
  const exec = spec.exec ?? execProcess
  const warm = spec.subjects.map((): ExecOutcome[] => [])
  const cold = spec.subjects.map((): ExecOutcome[] => [])

  const run = async (
    { subject, argv, cwd, env }: BenchSubjectSpec,
    phase: RunPhase,
    round: number,
    rounds: number,
  ): Promise<ExecOutcome> => {
    const startedAt = performance.now()
    let outcome: ExecOutcome
    try {
      outcome = await exec({ argv, cwd, env: env ?? {}, timeoutMs })
    } catch (error) {
      if (!(error instanceof BenchError) || error.code !== 'BENCH_EXEC_FAILED') throw error
      const reason = error.cause instanceof Error ? `: ${error.cause.message}` : ''
      outcome = {
        exitCode: SPAWN_FAILED_EXIT_CODE,
        wallMs: performance.now() - startedAt,
        warnings: [`${error.message}${reason}`],
      }
    }
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
      await Promise.all(subject.caches.map(({ path }) => clearCache(path)))
      cold[index]?.push(await run(subject, 'cold', round, coldRuns))
    }
  }

  return spec.subjects.flatMap(({ subject }, index) => [
    summarize(spec.benchId, subject, 'warm', warm[index] ?? []),
    summarize(spec.benchId, subject, 'cold', cold[index] ?? []),
  ])
}
