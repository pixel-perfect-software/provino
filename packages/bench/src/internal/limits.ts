// What the micro-benchmark CLIs share for their bars: a bar flag that isn't a number must stop
// the run, not compare as `NaN` (every comparison false, so the bar passes), and a missing sample
// must not read as 0 (B08 review).
import { BenchError } from '../errors.ts'
import { median } from '../stats.ts'

/**
 * The protocol both micro-benchmarks (`bench:hoist`, `bench:mock`) follow: `ROUNDS` rounds per
 * measurement in one process, the first `WARMUP_ROUNDS` thrown away, and `RUNS` processes.
 * @internal
 */
export const ROUNDS = 8
/** @internal */
export const WARMUP_ROUNDS = 2
/** @internal */
export const RUNS = 5

/**
 * The median of a process's rounds after the first `warmup` are discarded.
 * @internal
 */
export function keptMedian(perRound: readonly number[], warmup: number): number {
  return median(perRound.slice(warmup))
}

/**
 * The median of each of `keys` over the runs.
 * @internal
 */
export function medianSample<K extends string>(
  keys: readonly K[],
  runs: readonly Readonly<Record<K, number>>[],
): Record<K, number> {
  const out = {} as Record<K, number>
  for (const key of keys) out[key] = median(runs.map((run) => run[key]))
  return out
}

/**
 * The process exit code for the missed bars: 1 if any cell missed, otherwise 0.
 * @internal
 */
export function exitCodeFor(missed: readonly string[]): 0 | 1 {
  return missed.length === 0 ? 0 : 1
}

/**
 * Runs `parse` before any benchmark does. A `BENCH_USAGE` error is printed as `<tool>: <message>`
 * and ends the process with exit code 2; any other error is rethrown.
 * @internal
 */
export function parseOrExitUsage<T>(tool: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof BenchError && error.code === 'BENCH_USAGE') {
      process.stderr.write(`${tool}: ${error.message}\n`)
      process.exit(2)
    }
    throw error
  }
}

/**
 * The prefix of the one output line that carries a child process's sample, so a log or warning
 * that happens to look like JSON is never taken for it.
 * @internal
 */
export const SAMPLE_PREFIX = 'PROVINO_SAMPLE '

/**
 * A bar flag's value: `undefined` when the flag is absent; throws a `BENCH_USAGE` error unless it
 * is a finite number.
 * @internal
 */
export function parseLimit(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const limit = value.trim() === '' ? Number.NaN : Number(value)
  if (!Number.isFinite(limit)) {
    throw new BenchError('BENCH_USAGE', `--${flag} needs a number, got "${value}"`)
  }
  return limit
}

/**
 * A failed value printed beside its limit must never read as equal to it: `toFixed` can round 3599
 * of 4000 up to "90.0", 0.500004 down to "0.500" and 3.0004 to "3.000", which would call a miss a
 * tie. This raises the decimals from `base` until the printed number differs from the limit.
 * @internal
 */
export function pastLimit(value: number, limit: number, base: number): string {
  for (let decimals = base; decimals < 12; decimals += 1) {
    const text = value.toFixed(decimals)
    if (Number(text) !== limit) return text
  }
  return value.toString()
}

/**
 * The first `SAMPLE_PREFIX` line of `output` whose JSON object has every one of `keys` as a finite
 * number, or `undefined`. Lines without the prefix (warnings, logs that look like JSON) are ignored.
 * @internal
 */
export function readSample<K extends string>(
  output: string,
  keys: readonly K[],
): Record<K, number> | undefined {
  for (const line of output.split('\n')) {
    if (!line.startsWith(SAMPLE_PREFIX)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.slice(SAMPLE_PREFIX.length))
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const sample: Partial<Record<K, number>> = {}
    for (const key of keys) {
      const value: unknown = Reflect.get(parsed, key)
      if (typeof value === 'number' && Number.isFinite(value)) sample[key] = value
    }
    if (keys.every((key) => sample[key] !== undefined)) return sample as Record<K, number>
  }
  return undefined
}
