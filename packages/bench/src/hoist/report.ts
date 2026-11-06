// The pure parts of `bench:hoist`: arguments, medians, the bars and the cells that miss them.
// Nothing here runs a benchmark, so the tests can cover all of it.
import { parseArgs } from 'node:util'
import { BenchError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'
import { parseLimit, pastLimit } from '../internal/limits.ts'
import { median } from '../stats.ts'

/** The two inputs: the same size, with mock calls (and so the import rewrite) and without. */
export const CELLS = ['mocked', 'unmocked'] as const
export type Cell = (typeof CELLS)[number]
export const CELL_LABELS: Record<Cell, string> = {
  mocked: 'with mocks',
  unmocked: 'no mock call',
}

/** One process's sample: milliseconds per `hoistMocks` call, for each cell. */
export type Sample = Record<Cell, number>
export const SAMPLE_KEYS: readonly Cell[] = CELLS

/** Rounds per cell in one process, and how many of them (the first) are thrown away. */
export const ROUNDS = 8
export const WARMUP_ROUNDS = 2
/** Fresh processes. */
export const RUNS = 5
/** Calls per round: the unmocked file takes microseconds, so a round times many of them. */
export const CALLS_PER_ROUND: Record<Cell, number> = { mocked: 3, unmocked: 500 }

/** The size of both inputs, and the seed that makes them the same on every machine. */
export const TARGET_BYTES: number = 15 * 1024
export const SEED = 20261106

export interface Bars {
  /** Largest median, in ms, for the file with mocks. */
  readonly maxMockedMs: number | undefined
  /** Largest median, in ms, for the file without. */
  readonly maxUnmockedMs: number | undefined
}

/** Reads the flags; throws a `BENCH_USAGE` `BenchError` for an unknown flag or a non-number bar. */
export function parseBars(argv: readonly string[]): Bars {
  let values: { 'max-mocked-ms'?: string | undefined; 'max-unmocked-ms'?: string | undefined }
  try {
    values = parseArgs({
      args: [...argv],
      options: { 'max-mocked-ms': { type: 'string' }, 'max-unmocked-ms': { type: 'string' } },
    }).values
  } catch (error) {
    throw new BenchError('BENCH_USAGE', errorMessage(error))
  }
  return {
    maxMockedMs: parseLimit('max-mocked-ms', values['max-mocked-ms']),
    maxUnmockedMs: parseLimit('max-unmocked-ms', values['max-unmocked-ms']),
  }
}

/** The median of each cell over the runs. */
export function medianSample(runs: readonly Sample[]): Sample {
  const out = {} as Sample
  for (const cell of CELLS) out[cell] = median(runs.map((run) => run[cell]))
  return out
}

/** The median of a process's rounds after the warm-up rounds. */
export function keptMedian(perRound: readonly number[]): number {
  return median(perRound.slice(WARMUP_ROUNDS))
}

/** The process exit code for the missed bars: 1 if any cell missed, otherwise 0. */
export function exitCodeFor(missed: readonly string[]): 0 | 1 {
  return missed.length === 0 ? 0 : 1
}

/**
 * Every bar a cell misses, one line each, naming the cell. Written `!(x <= bar)` so a NaN misses.
 */
export function failures(medians: Sample, bars: Bars): readonly string[] {
  const out: string[] = []
  const limits: Record<Cell, number | undefined> = {
    mocked: bars.maxMockedMs,
    unmocked: bars.maxUnmockedMs,
  }
  for (const cell of CELLS) {
    const limit = limits[cell]
    if (limit === undefined) continue
    if (!(medians[cell] <= limit)) {
      out.push(
        `FAIL ${cell} (${CELL_LABELS[cell]}) is ${pastLimit(medians[cell], limit, 3)} ms; the bar is ≤ ${limit} ms`,
      )
    }
  }
  return out
}
