// The pure part of `bench:expect-import`: what the samples say and whether the bar holds.
import { BenchError } from '../errors.ts'
import { medianSample, overBar, parseLimit, pastLimit } from '../internal/limits.ts'

/** What one fresh process measured, in milliseconds. */
export const KEYS = ['entry', 'engine', 'total'] as const

/**
 * One process: `entry` is `import('provino')` (the built entry), `engine` is the worker-side
 * `expect` it stands for (the built Jest-dialect runtime, which loads the engine, the dialect's
 * `expect` table and pretty-format), and `total` is both.
 * @internal
 */
export type ImportSample = Readonly<Record<(typeof KEYS)[number], number>>

/** The worker runtime each dialect's `expect` is, under the built `provino`'s `dist`. */
export const RUNTIMES = {
  jest: 'worker/jest-runtime.js',
  vitest: 'worker/vitest-runtime.js',
} as const

/**
 * A dialect the bench measures.
 * @internal
 */
export type ImportDialect = keyof typeof RUNTIMES

/**
 * The command's flags. `--max-cold-ms` is T7.12's bar, decided for Jest's runtime: no Vitest bar
 * is decided, so it is refused with `--dialect vitest` rather than applied to a number it was never
 * set for.
 * @internal
 */
export function parseImportArgs(values: {
  readonly dialect: string
  readonly 'max-cold-ms'?: string | undefined
  readonly runs?: string | undefined
}): {
  readonly dialect: ImportDialect
  readonly maxColdMs: number | undefined
  readonly runs: number
} {
  if (!(values.dialect in RUNTIMES)) {
    throw new BenchError('BENCH_USAGE', '--dialect takes jest or vitest')
  }
  const dialect = values.dialect as ImportDialect
  const runs = values.runs === undefined ? DEFAULT_RUNS : parseLimit('runs', values.runs)
  if (runs === undefined || !Number.isInteger(runs) || runs < 1) {
    throw new BenchError('BENCH_USAGE', '--runs needs a whole number of at least 1')
  }
  const maxColdMs = parseLimit('max-cold-ms', values['max-cold-ms'])
  if (maxColdMs !== undefined && dialect !== 'jest') {
    throw new BenchError(
      'BENCH_USAGE',
      "--max-cold-ms is T7.12's bar for Jest's runtime; no bar is decided for --dialect vitest",
    )
  }
  return { dialect, maxColdMs, runs }
}

const DEFAULT_RUNS = 15

/** What the second line says the worker-side `expect` holds, per dialect. */
const HOLDS: Readonly<Record<ImportDialect, string>> = {
  jest: "engine, the Jest dialect's table, pretty-format",
  vitest: "engine, the Vitest dialect's table, pretty-format; no Chai",
}

/**
 * The median of each part over the processes.
 * @internal
 */
export function summarise(samples: readonly ImportSample[]): ImportSample {
  return medianSample(KEYS, samples)
}

/**
 * The report lines for a summary and the failure line when the total is over the bar. T7.12's
 * bar is on the total: the worker-side cost of having `expect`, not only the import of the entry
 * file that forwards to it (which is under a millisecond because the engine is not in it).
 * @internal
 */
export function describeRun(
  summary: ImportSample,
  options: {
    readonly dialect: ImportDialect
    readonly processes: number
    readonly node: string
    readonly maxColdMs: number | undefined
  },
): { readonly lines: readonly string[]; readonly ok: boolean } {
  const ms = (value: number): string => `${value.toFixed(1)} ms`
  const lines = [
    `expect import bench (local, ${options.dialect} dialect: ${RUNTIMES[options.dialect]}, Node ${options.node}, ${options.processes} fresh processes, median inside the process)`,
    `  import { expect } from 'provino'             ${ms(summary.entry)}`,
    `  + the worker-side expect it forwards to      ${ms(summary.engine)}   (${HOLDS[options.dialect]})`,
    `  total                                        ${ms(summary.total)}`,
  ]
  const bar = options.maxColdMs
  if (bar === undefined) return { lines, ok: true }
  if (overBar(summary.total, bar)) {
    lines.push(`FAIL total is ${pastLimit(summary.total, bar, 1)} ms; the bar is ≤ ${bar} ms`)
    return { lines, ok: false }
  }
  return { lines, ok: true }
}
