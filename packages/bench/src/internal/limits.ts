// What the micro-benchmark CLIs share for their bars: a bar flag that isn't a number must stop
// the run, not compare as `NaN` (every comparison false, so the bar passes), and a missing sample
// must not read as 0 (B08 review).
import { BenchError } from '../errors.ts'

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
