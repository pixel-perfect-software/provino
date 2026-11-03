import type { WallStats } from '@provino/types'
import { BenchError } from './errors.ts'
import { randomBelow, seededRandom } from './internal/prng.ts'

/**
 * Bootstrap resamples per confidence interval (Track 12 R5).
 */
const BOOTSTRAP_RESAMPLES = 2000

/**
 * The seed bootstrap intervals use unless the caller passes one, so the same samples always give
 * the same interval.
 */
const BOOTSTRAP_SEED = 0x70726f76

/**
 * A closed interval.
 * @public
 */
export interface Interval {
  readonly low: number
  readonly high: number
}

/**
 * A ratio of two medians and its bootstrap 95% confidence interval.
 * @public
 */
export interface RatioInterval extends Interval {
  /** `median(a) / median(b)`. */
  readonly ratio: number
}

/**
 * Bootstrap settings. The defaults are the protocol's: 2,000 resamples from a fixed seed.
 * @public
 */
export interface BootstrapOptions {
  readonly resamples?: number
  readonly seed?: number
}

function at(values: ArrayLike<number>, index: number): number {
  const value = values[index]
  if (value === undefined) throw new RangeError(`index ${index} is outside 0..${values.length - 1}`)
  return value
}

function checked(samples: readonly number[], what: string): readonly number[] {
  if (samples.length === 0) {
    throw new BenchError('BENCH_INVALID_SAMPLES', `${what} needs at least one sample`)
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      throw new BenchError('BENCH_INVALID_SAMPLES', `${what} got a non-finite sample: ${sample}`)
    }
  }
  return samples
}

function sorted(samples: readonly number[], what: string): Float64Array {
  return Float64Array.from(checked(samples, what)).sort()
}

// Linear interpolation between order statistics (Hyndman and Fan type 7, the default of R and
// NumPy). `values` must be sorted ascending and non-empty.
function quantileSorted(values: ArrayLike<number>, q: number): number {
  const position = (values.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const low = at(values, lower)
  return low + (position - lower) * (at(values, upper) - low)
}

/**
 * The q-th quantile (0 to 1) by linear interpolation between order statistics (type 7).
 * @public
 */
export function quantile(samples: readonly number[], q: number): number {
  if (!(q >= 0 && q <= 1)) {
    throw new BenchError('BENCH_INVALID_SAMPLES', `quantile needs 0 <= q <= 1, got ${q}`)
  }
  return quantileSorted(sorted(samples, 'quantile'), q)
}

/**
 * The median: the middle sample, or the mean of the two middle samples.
 * @public
 */
export function median(samples: readonly number[]): number {
  return quantileSorted(sorted(samples, 'median'), 0.5)
}

/**
 * The smallest sample.
 * @public
 */
export function min(samples: readonly number[]): number {
  return at(sorted(samples, 'min'), 0)
}

/**
 * The largest sample.
 * @public
 */
export function max(samples: readonly number[]): number {
  const values = sorted(samples, 'max')
  return at(values, values.length - 1)
}

/**
 * The arithmetic mean.
 * @public
 */
export function mean(samples: readonly number[]): number {
  return sum(checked(samples, 'mean')) / samples.length
}

function sum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}

/**
 * The sample standard deviation (divides by n - 1). One sample has none, so it gives 0.
 * @public
 */
export function standardDeviation(samples: readonly number[]): number {
  const average = mean(samples)
  if (samples.length < 2) return 0
  let squares = 0
  for (const sample of samples) squares += (sample - average) ** 2
  return Math.sqrt(squares / (samples.length - 1))
}

/**
 * The coefficient of variation: sample standard deviation over the mean. A mean of 0 gives 0.
 * @public
 */
export function coefficientOfVariation(samples: readonly number[]): number {
  const average = mean(samples)
  return average === 0 ? 0 : standardDeviation(samples) / average
}

function medianOfDraws(draws: Float64Array): number {
  draws.sort()
  return quantileSorted(draws, 0.5)
}

function percentileInterval(estimates: Float64Array): Interval {
  estimates.sort()
  return { low: quantileSorted(estimates, 0.025), high: quantileSorted(estimates, 0.975) }
}

function resampleCount(options: BootstrapOptions | undefined): number {
  const resamples = options?.resamples ?? BOOTSTRAP_RESAMPLES
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new BenchError('BENCH_INVALID_SAMPLES', `resamples must be a positive integer`)
  }
  return resamples
}

function draw(from: readonly number[], into: Float64Array, random: () => number): void {
  for (let i = 0; i < into.length; i++) into[i] = at(from, randomBelow(random, from.length))
}

/**
 * The 95% bootstrap confidence interval of the median: resample with replacement, take each
 * resample's median, and read the 2.5th and 97.5th percentiles. The seeded generator makes it
 * deterministic.
 * @public
 */
export function bootstrapMedianCi(
  samples: readonly number[],
  options?: BootstrapOptions,
): Interval {
  checked(samples, 'bootstrapMedianCi')
  const random = seededRandom(options?.seed ?? BOOTSTRAP_SEED)
  const medians = new Float64Array(resampleCount(options))
  const buffer = new Float64Array(samples.length)
  for (let i = 0; i < medians.length; i++) {
    draw(samples, buffer, random)
    medians[i] = medianOfDraws(buffer)
  }
  return percentileInterval(medians)
}

/**
 * The ratio of two medians, `median(a) / median(b)`, with its 95% bootstrap confidence interval:
 * each side is resampled on its own, and the interval is the 2.5th to 97.5th percentile of the
 * resampled ratios. R6's speed check compares the upper bound against a threshold. Every sample
 * of `b` must be positive.
 * @public
 */
export function ratioCi(
  a: readonly number[],
  b: readonly number[],
  options?: BootstrapOptions,
): RatioInterval {
  checked(a, 'ratioCi numerator')
  checked(b, 'ratioCi denominator')
  if (b.some((sample) => sample <= 0)) {
    throw new BenchError('BENCH_INVALID_SAMPLES', 'ratioCi denominator samples must be positive')
  }
  const random = seededRandom(options?.seed ?? BOOTSTRAP_SEED)
  const ratios = new Float64Array(resampleCount(options))
  const bufferA = new Float64Array(a.length)
  const bufferB = new Float64Array(b.length)
  for (let i = 0; i < ratios.length; i++) {
    draw(a, bufferA, random)
    draw(b, bufferB, random)
    ratios[i] = medianOfDraws(bufferA) / medianOfDraws(bufferB)
  }
  return { ratio: median(a) / median(b), ...percentileInterval(ratios) }
}

/**
 * Wall-clock statistics for a subject's timed runs: median, quartiles, min, max, the median's
 * bootstrap 95% CI, CV, and every sample in run order (none are dropped).
 * @public
 */
export function wallStats(samples: readonly number[], options?: BootstrapOptions): WallStats {
  const values = sorted(samples, 'wallStats')
  const ci = bootstrapMedianCi(samples, options)
  return {
    runs: values.length,
    medianMs: quantileSorted(values, 0.5),
    q1Ms: quantileSorted(values, 0.25),
    q3Ms: quantileSorted(values, 0.75),
    minMs: at(values, 0),
    maxMs: at(values, values.length - 1),
    ciLowMs: ci.low,
    ciHighMs: ci.high,
    cv: coefficientOfVariation(samples),
    samplesMs: [...samples],
  }
}
