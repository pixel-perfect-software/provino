import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  callRatio,
  ENGINES,
  type Engine,
  exitCodeFor,
  failures,
  medianSample,
  parseBars,
  type Sample,
} from './report.ts'

const sample = (over: Partial<Sample> = {}): Sample => ({
  create: 200,
  createArrow: 250,
  createFunction: 260,
  createArrowUse: 400,
  call: 10,
  ...over,
})
const all = (over: Partial<Record<Engine, Sample>> = {}): Record<Engine, Sample> => ({
  'provino-jest': sample(),
  'provino-vitest': sample(),
  'vitest-spy': sample(),
  'jest-mock': sample(),
  ...over,
})
const bars = { maxCreateUs: 1, maxCallRatio: 1.5 }

test('no flags is no bars; both flags parse as numbers', () => {
  assert.deepEqual(parseBars([]), { maxCreateUs: undefined, maxCallRatio: undefined })
  assert.deepEqual(parseBars(['--max-create-us', '1', '--max-call-ratio', '1.5']), bars)
})

test('bad usage is a BENCH_USAGE error: a non-number bar or an unknown flag', () => {
  for (const argv of [['--max-create-us', 'fast'], ['--max-call-ratio'], ['--nope', '1']]) {
    assert.throws(() => parseBars(argv), { name: 'BenchError', code: 'BENCH_USAGE' })
  }
})

test('the median of each key is taken over the runs, and the ratio is call over call', () => {
  const med = medianSample([sample({ call: 30 }), sample({ call: 10 }), sample({ call: 20 })])
  assert.equal(med.call, 20)
  assert.equal(callRatio(sample({ call: 15 }), sample({ call: 10 })), 1.5)
})

test('cells within the bars pass; no bars never fails', () => {
  assert.deepEqual(failures(all(), bars), [])
  assert.deepEqual(
    failures(all({ 'provino-vitest': sample({ createFunction: 9000 }) }), {
      maxCreateUs: undefined,
      maxCallRatio: undefined,
    }),
    [],
  )
})

test('a creation cell over the bar is named by engine and shape, and only that cell', () => {
  const missed = failures(all({ 'provino-vitest': sample({ createFunction: 1388 }) }), bars)
  assert.equal(exitCodeFor(missed), 1)
  assert.equal(exitCodeFor(failures(all(), bars)), 0)
  assert.equal(missed.length, 1)
  assert.match(missed[0] ?? '', /^FAIL provino-vitest fn\(function\) creation is 1\.388 µs/)
})

test('a call over the ratio bar is named; the baselines have no bar', () => {
  const missed = failures(
    all({
      'provino-jest': sample({ call: 16 }),
      'jest-mock': sample({ create: 99_999, call: 99 }),
    }),
    bars,
  )
  assert.equal(missed.length, 1)
  assert.match(missed[0] ?? '', /^FAIL provino-jest call is 1\.60× @vitest\/spy/)
})

test('a failed value never prints equal to its bar', () => {
  const create = failures(all({ 'provino-jest': sample({ create: 1000.4 }) }), bars)
  assert.match(create[0] ?? '', /creation is 1\.0004 µs; the bar is ≤ 1 µs/)
  const call = failures(all({ 'provino-jest': sample({ call: 15.04 }) }), bars)
  assert.match(call[0] ?? '', /call is 1\.504× @vitest\/spy; the bar is ≤ 1\.5×/)
})

test('the first-use column has no bar', () => {
  const med = all({ 'provino-vitest': sample({ createArrowUse: 99_999 }) })
  assert.deepEqual(failures(med, bars), [])
})

test('a NaN measurement misses instead of passing', () => {
  assert.equal(failures(all({ 'provino-jest': sample({ create: Number.NaN }) }), bars).length, 1)
})

test('every engine is listed once', () => {
  assert.equal(new Set(ENGINES).size, ENGINES.length)
})
