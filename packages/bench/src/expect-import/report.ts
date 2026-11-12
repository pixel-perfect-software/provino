// The pure part of `bench:expect-import`: what the samples say and whether the bar holds.
import { overBar, pastLimit } from '../internal/limits.ts'
import { median } from '../stats.ts'

/** What one fresh process measured, in milliseconds. */
export const KEYS = ['entry', 'engine', 'total'] as const

/**
 * One process: `entry` is `import('provino')` (the built entry), `engine` is the worker-side
 * `expect` it stands for (the built Jest-dialect runtime, which loads the engine, the dialect's
 * `expect` table and pretty-format), and `total` is both.
 * @internal
 */
export type ImportSample = Readonly<Record<(typeof KEYS)[number], number>>

/**
 * The median of each part over the processes.
 * @internal
 */
export function summarise(samples: readonly ImportSample[]): ImportSample {
  return {
    entry: median(samples.map((sample) => sample.entry)),
    engine: median(samples.map((sample) => sample.engine)),
    total: median(samples.map((sample) => sample.total)),
  }
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
    readonly processes: number
    readonly node: string
    readonly maxColdMs: number | undefined
  },
): { readonly lines: readonly string[]; readonly ok: boolean } {
  const ms = (value: number): string => `${value.toFixed(1)} ms`
  const lines = [
    `expect import bench (local, Node ${options.node}, ${options.processes} fresh processes, median inside the process)`,
    `  import { expect } from 'provino'             ${ms(summary.entry)}`,
    `  + the worker-side expect it forwards to      ${ms(summary.engine)}   (engine, the Jest dialect's table, pretty-format)`,
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
