// The pure parts of `bench:mock`: arguments, medians, the call ratio, the bars and the cells that
// miss them. Nothing here runs a benchmark, so the tests can cover all of it.
import { parseArgs } from 'node:util'
import { BenchError } from '../errors.ts'
import { errorMessage } from '../internal/guards.ts'
import { parseLimit, pastLimit } from '../internal/limits.ts'
import { median } from '../stats.ts'

/** The engines, in the order they print. The first two are Provino under each dialect's policy. */
export const ENGINES = ['provino-jest', 'provino-vitest', 'vitest-spy', 'jest-mock'] as const
export type Engine = (typeof ENGINES)[number]

/** Rounds per measurement in one process, and how many of them (the first) are thrown away. */
export const ROUNDS = 8
export const WARMUP_ROUNDS = 2
/** Processes per engine, interleaved. */
export const RUNS = 5

/** The engines T4.3's bars apply to. */
export const BARRED_ENGINES = ['provino-jest', 'provino-vitest'] as const

/** The creation cells, as keys of a sample and as printed. */
export const CREATE_CELLS = ['create', 'createArrow', 'createFunction'] as const
export type CreateCell = (typeof CREATE_CELLS)[number]
export const CELL_LABELS: Record<CreateCell, string> = {
  create: 'fn()',
  createArrow: 'fn(arrow)',
  createFunction: 'fn(function)',
}

/** The keys of one engine's sample: ns per mock created for each shape, and ns per call. */
export const SAMPLE_KEYS: readonly [
  'create',
  'createArrow',
  'createFunction',
  'createArrowUse',
  'call',
] = ['create', 'createArrow', 'createFunction', 'createArrowUse', 'call']
/** `fn(arrow)+use`: create from a new closure, call once, read `.mock.calls.length`. No bar. */
export const USE_LABEL = 'fn(arrow)+use'
export type Sample = Record<(typeof SAMPLE_KEYS)[number], number>

export interface Bars {
  /** Largest creation time, in µs, for any cell of a Provino policy. */
  readonly maxCreateUs: number | undefined
  /** Largest ratio of a Provino policy's median call to `@vitest/spy`'s. */
  readonly maxCallRatio: number | undefined
}

/** Reads the flags; throws a `BENCH_USAGE` `BenchError` for an unknown flag or a non-number bar. */
export function parseBars(argv: readonly string[]): Bars {
  let values: { 'max-create-us'?: string | undefined; 'max-call-ratio'?: string | undefined }
  try {
    values = parseArgs({
      args: [...argv],
      options: { 'max-create-us': { type: 'string' }, 'max-call-ratio': { type: 'string' } },
    }).values
  } catch (error) {
    throw new BenchError('BENCH_USAGE', errorMessage(error))
  }
  return {
    maxCreateUs: parseLimit('max-create-us', values['max-create-us']),
    maxCallRatio: parseLimit('max-call-ratio', values['max-call-ratio']),
  }
}

/** The median of each key over an engine's runs. */
export function medianSample(runs: readonly Sample[]): Sample {
  const out = {} as Sample
  for (const key of SAMPLE_KEYS) out[key] = median(runs.map((run) => run[key]))
  return out
}

/** `engine`'s median call over `baseline`'s. */
export function callRatio(engine: Sample, baseline: Sample): number {
  return engine.call / baseline.call
}

/** The process exit code for the missed bars: 1 if any cell missed, otherwise 0. */
export function exitCodeFor(missed: readonly string[]): 0 | 1 {
  return missed.length === 0 ? 0 : 1
}

/**
 * Every bar a Provino policy misses, one line per cell. A cell is named by engine and shape (or
 * "call"). Written `!(x <= bar)` so a NaN misses. No cell is exempt.
 */
export function failures(medians: Readonly<Record<Engine, Sample>>, bars: Bars): readonly string[] {
  const out: string[] = []
  for (const engine of BARRED_ENGINES) {
    const sample = medians[engine]
    if (bars.maxCreateUs !== undefined) {
      for (const cell of CREATE_CELLS) {
        const us = sample[cell] / 1000
        if (!(us <= bars.maxCreateUs)) {
          out.push(
            `FAIL ${engine} ${CELL_LABELS[cell]} creation is ${pastLimit(us, bars.maxCreateUs, 3)} µs; the bar is ≤ ${bars.maxCreateUs} µs`,
          )
        }
      }
    }
    if (bars.maxCallRatio !== undefined) {
      const ratio = callRatio(sample, medians['vitest-spy'])
      if (!(ratio <= bars.maxCallRatio)) {
        out.push(
          `FAIL ${engine} call is ${pastLimit(ratio, bars.maxCallRatio, 2)}× @vitest/spy; the bar is ≤ ${bars.maxCallRatio}×`,
        )
      }
    }
  }
  return out
}
