// The pure side of `bench:env` (T8.3's jsdom bar): the flags, the two numbers and the bars.
import { parseArgs } from 'node:util'
import { BenchError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'
import { overBar, parseLimit, pastLimit } from '../internal/limits.ts'

/** The bars and the sizes of a run. A bar that is `undefined` is not checked. */
export interface Bars {
  readonly maxRatio: number | undefined
  readonly maxHeapMb: number | undefined
  /** Files (fresh windows) per round, and in the heap measurement. */
  readonly files: number
  readonly rounds: number
}

/** The files per round and the rounds of the timing, and of the heap measurement's files. */
const DEFAULT_FILES = 100
const DEFAULT_ROUNDS = 5

function count(flag: string, value: string | undefined, fallback: number): number {
  const parsed = parseLimit(flag, value)
  if (parsed === undefined) return fallback
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BenchError(
      'BENCH_USAGE',
      `--${flag} needs a whole number of at least 1, got "${value}"`,
    )
  }
  return parsed
}

/** Reads the flags; throws a `BENCH_USAGE` `BenchError` for an unknown flag or a bad value. */
export function parseBars(argv: readonly string[]): Bars {
  let values: Partial<Record<'max-ratio' | 'max-heap-mb' | 'files' | 'rounds', string>>
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        'max-ratio': { type: 'string' },
        'max-heap-mb': { type: 'string' },
        files: { type: 'string' },
        rounds: { type: 'string' },
      },
    }).values
  } catch (error) {
    throw new BenchError('BENCH_USAGE', errorMessage(error))
  }
  return {
    maxRatio: parseLimit('max-ratio', values['max-ratio']),
    maxHeapMb: parseLimit('max-heap-mb', values['max-heap-mb']),
    files: count('files', values.files, DEFAULT_FILES),
    rounds: count('rounds', values.rounds, DEFAULT_ROUNDS),
  }
}

/** Heap growth in megabytes between two after-GC readings, in bytes. */
export function heapGrowthMb(beforeBytes: number, afterBytes: number): number {
  return (afterBytes - beforeBytes) / (1024 * 1024)
}

/** What the run measured. */
export interface Measured {
  readonly ratio: number
  readonly heapMb: number
}

/** Every bar missed, one line each. Written `!(x <= bar)` so a NaN misses. */
export function failures(measured: Measured, bars: Bars): readonly string[] {
  const out: string[] = []
  if (bars.maxRatio !== undefined && overBar(measured.ratio, bars.maxRatio)) {
    out.push(
      `FAIL per-file median is ${pastLimit(measured.ratio, bars.maxRatio, 3)}× the raw-jsdom baseline; the bar is ≤ ${bars.maxRatio}×`,
    )
  }
  if (bars.maxHeapMb !== undefined && overBar(measured.heapMb, bars.maxHeapMb)) {
    out.push(
      `FAIL heap growth after GC is ${pastLimit(measured.heapMb, bars.maxHeapMb, 2)} MB; the bar is ≤ ${bars.maxHeapMb} MB`,
    )
  }
  return out
}
