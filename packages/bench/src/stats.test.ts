import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BenchError } from './errors.ts'
import {
  bootstrapMedianCi,
  coefficientOfVariation,
  max,
  mean,
  median,
  min,
  quantile,
  ratioCi,
  standardDeviation,
  wallStats,
} from './stats.ts'

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  )
}

function assertInvalid(run: () => unknown): void {
  assert.throws(
    run,
    (error) => error instanceof BenchError && error.code === 'BENCH_INVALID_SAMPLES',
  )
}

const odd = [4, 1, 3, 2, 10]
const even = [4, 2, 1, 3]

test('median is the middle sample, or the mean of the two middle ones', () => {
  assert.equal(median(odd), 3)
  assert.equal(median(even), 2.5)
  assert.equal(median([7]), 7)
})

test('quartiles interpolate linearly between order statistics (type 7)', () => {
  assert.equal(quantile(odd, 0.25), 2)
  assert.equal(quantile(odd, 0.75), 4)
  assert.equal(quantile(even, 0.25), 1.75)
  assert.equal(quantile(even, 0.75), 3.25)
  assertClose(quantile([10, 20], 0.1), 11)
  assert.equal(quantile(odd, 0), 1)
  assert.equal(quantile(odd, 1), 10)
})

test('min, max and mean', () => {
  assert.equal(min(odd), 1)
  assert.equal(max(odd), 10)
  assert.equal(mean(odd), 4)
  assert.equal(mean(even), 2.5)
})

test('standard deviation is the sample one and CV divides it by the mean', () => {
  // squares of the deviations from the mean 4 sum to 50, over n - 1 = 4
  assertClose(standardDeviation(odd), Math.sqrt(12.5))
  assertClose(coefficientOfVariation(odd), Math.sqrt(12.5) / 4)
  // 2.25 + 0.25 + 0.25 + 2.25 = 5, over 3
  assertClose(coefficientOfVariation(even), Math.sqrt(5 / 3) / 2.5)
})

test('one sample has no spread, and a zero mean has no CV', () => {
  assert.equal(standardDeviation([5]), 0)
  assert.equal(coefficientOfVariation([5]), 0)
  assert.equal(coefficientOfVariation([0, 0, 0]), 0)
})

test('the statistics do not reorder the caller’s samples', () => {
  const samples = [3, 1, 2]
  median(samples)
  quantile(samples, 0.5)
  wallStats(samples)
  assert.deepEqual(samples, [3, 1, 2])
})

test('empty and non-finite samples are rejected with a stable code', () => {
  assertInvalid(() => median([]))
  assertInvalid(() => median([1, Number.NaN]))
  assertInvalid(() => mean([1, Number.POSITIVE_INFINITY]))
  assertInvalid(() => wallStats([]))
  assertInvalid(() => quantile([1, 2], 1.5))
  assertInvalid(() => bootstrapMedianCi([1, 2], { resamples: 0 }))
})

test('the bootstrap CI is deterministic: the same samples give the same interval', () => {
  const samples = [1180, 1203, 1195, 1260, 1175, 1210, 1188, 1301, 1190, 1204]
  assert.deepEqual(bootstrapMedianCi(samples), bootstrapMedianCi([...samples]))
  assert.deepEqual(wallStats(samples), wallStats([...samples]))
})

test('a different seed gives a different interval, the same seed the same one', () => {
  const samples = [1180, 1203, 1195, 1260, 1175, 1210, 1188, 1301, 1190, 1204]
  assert.deepEqual(bootstrapMedianCi(samples, { seed: 7 }), bootstrapMedianCi(samples, { seed: 7 }))
  assert.notDeepEqual(
    bootstrapMedianCi(samples, { seed: 7 }),
    bootstrapMedianCi(samples, { seed: 8 }),
  )
})

test('the bootstrap CI stays inside the samples’ range and brackets the median', () => {
  const samples = [1180, 1203, 1195, 1260, 1175, 1210, 1188, 1301, 1190, 1204]
  const ci = bootstrapMedianCi(samples)
  assert.ok(ci.low >= min(samples) && ci.high <= max(samples))
  assert.ok(ci.low <= median(samples) && median(samples) <= ci.high)
  assert.ok(ci.low < ci.high)
})

test('the bootstrap CI of identical or single samples is that value', () => {
  assert.deepEqual(bootstrapMedianCi([5, 5, 5, 5]), { low: 5, high: 5 })
  assert.deepEqual(bootstrapMedianCi([42]), { low: 42, high: 42 })
})

test('wallStats reports every statistic and keeps the samples in run order', () => {
  const stats = wallStats(odd)
  assert.equal(stats.runs, 5)
  assert.equal(stats.medianMs, 3)
  assert.equal(stats.q1Ms, 2)
  assert.equal(stats.q3Ms, 4)
  assert.equal(stats.minMs, 1)
  assert.equal(stats.maxMs, 10)
  assertClose(stats.cv, Math.sqrt(12.5) / 4)
  assert.deepEqual(stats.samplesMs, [4, 1, 3, 2, 10])
  assert.ok(stats.ciLowMs >= 1 && stats.ciLowMs <= 3)
  assert.ok(stats.ciHighMs >= 3 && stats.ciHighMs <= 10)
})

test('ratioCi of constant samples is the exact ratio with a zero-width interval', () => {
  assert.deepEqual(ratioCi([5, 5, 5], [10, 10, 10]), { ratio: 0.5, low: 0.5, high: 0.5 })
})

test('ratioCi spans the resampled medians of the numerator', () => {
  // With three samples the resampled median is each end sample about 26% of the time, so the 2.5th
  // and 97.5th percentiles are the ends: 40/100 and 60/100.
  assert.deepEqual(ratioCi([40, 50, 60], [100, 100, 100]), { ratio: 0.5, low: 0.4, high: 0.6 })
})

test('ratioCi is deterministic and its interval brackets the ratio', () => {
  const a = [510, 495, 502, 530, 488, 515, 500, 509, 497, 505]
  const b = [1010, 990, 1005, 1060, 985, 1020, 1000, 1012, 995, 1003]
  const first = ratioCi(a, b)
  assert.deepEqual(first, ratioCi([...a], [...b]))
  assertClose(first.ratio, median(a) / median(b))
  assert.ok(first.low <= first.ratio && first.ratio <= first.high)
  assert.ok(first.high < 0.6)
})

test('ratioCi rejects a non-positive denominator', () => {
  assertInvalid(() => ratioCi([1], [0]))
  assertInvalid(() => ratioCi([], [1]))
})
