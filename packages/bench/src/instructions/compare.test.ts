import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BenchRecord, BenchResult } from '@provino/types'
import { BenchError } from '../errors.ts'
import { code } from '../internal/test-helpers.ts'
import {
  anyRegressed,
  assertBaselineCovers,
  assertComparable,
  assertSameCounting,
  COUNTING_KEYS,
  compareLeg,
  comparisonLines,
  countingRunners,
  countsOf,
  signedPercent,
  unjudgedLegs,
} from './compare.ts'
import { LEGS, legOf } from './legs.ts'

const suite = legOf('app-50')
const core = legOf('core')
if (suite === undefined || core === undefined) throw new Error('legs are missing')

const BASELINE = 2_400_000_000

test('a planted +2% regression is flagged at the +1.5% line', () => {
  const planted = compareLeg(suite, BASELINE * 1.02, BASELINE)
  assert.equal(planted.status, 'regressed')
  assert.ok(Math.abs((planted.deltaPercent ?? 0) - 2) < 1e-9)
  assert.ok(anyRegressed([planted]))
  const lines = comparisonLines([planted])
  assert.ok(lines.some((line) => line.includes('**REGRESSED**')))
  assert.ok(
    lines.includes('REGRESSED app-50 (T12.13): +2.00% instructions, at or over the +1.5% line'),
  )
})

test('a +1% rise is within the +1.5% line, and is not flagged', () => {
  const rise = compareLeg(suite, BASELINE * 1.01, BASELINE)
  assert.equal(rise.status, 'within')
  assert.equal(anyRegressed([rise]), false)
  assert.ok(comparisonLines([rise]).every((line) => !line.startsWith('REGRESSED')))
})

test('a rise of exactly the threshold is flagged; just under is not', () => {
  assert.equal(compareLeg(suite, BASELINE * 1.015, BASELINE).status, 'regressed')
  assert.equal(compareLeg(suite, BASELINE * 1.0149, BASELINE).status, 'within')
})

test('a fall is within', () => {
  assert.equal(compareLeg(suite, BASELINE * 0.9, BASELINE).status, 'within')
})

test('each leg flags at its own task’s line: +20% for T5.14 and T3.12', () => {
  assert.equal(compareLeg(core, BASELINE * 1.02, BASELINE).status, 'within')
  assert.equal(compareLeg(core, BASELINE * 1.2, BASELINE).status, 'regressed')
  for (const leg of LEGS) {
    assert.equal(leg.thresholdPercent, leg.task === 'T12.13' || leg.task === 'T2.12' ? 1.5 : 20)
  }
})

test('a delta that is not a number is flagged, never passed', () => {
  assert.equal(compareLeg(suite, Number.NaN, BASELINE).status, 'regressed')
})

test('no count is not-measured; no baseline compares nothing', () => {
  assert.equal(compareLeg(suite, undefined, BASELINE).status, 'not-measured')
  assert.equal(compareLeg(suite, BASELINE, undefined).status, 'no-baseline')
  assert.equal(anyRegressed([compareLeg(suite, undefined, undefined)]), false)
})

test('the change never prints the threshold for a value that is not it', () => {
  assert.equal(signedPercent(1.4996, 1.5), '+1.4996%')
  assert.equal(signedPercent(2, 1.5), '+2.00%')
  assert.equal(signedPercent(-0.3125, 1.5), '-0.31%')
})

function result(benchId: string, instructions: number | undefined, ok = true): BenchResult {
  return {
    benchId,
    subject: { runner: 'provino:jest', version: '0.0.0', isolation: 'registry', command: 'x' },
    cache: 'cold',
    wall: {
      runs: 1,
      medianMs: 1,
      q1Ms: 1,
      q3Ms: 1,
      minMs: 1,
      maxMs: 1,
      ciLowMs: 1,
      ciHighMs: 1,
      cv: 0,
      samplesMs: [1],
    },
    ...(instructions === undefined ? {} : { instructions }),
    ok,
  }
}

function record(
  results: readonly BenchResult[],
  machine: Partial<BenchRecord['machine']> = {},
): BenchRecord {
  return {
    schemaVersion: 1,
    label: 'local',
    ref: { sha: 'abc', date: '2026-11-13T00:00:00.000Z', dirty: false },
    machine: {
      os: 'linux',
      osRelease: '6',
      arch: 'arm64',
      cpuModel: 'x',
      cpuCount: 1,
      memoryMb: 1,
      node: 'v24.22.1',
      runners: {},
      ci: false,
      id: 'local-linux-arm64',
      ...machine,
    },
    results,
  }
}

test('a baseline record gives each measured leg its count; failed or uncounted results are none', () => {
  const counts = countsOf(
    record([
      result('instructions/app-50', 100),
      result('instructions/core', 7, false),
      result('instructions/hoist', undefined),
      result('app-500', 9),
    ]),
  )
  assert.deepEqual([...counts], [['app-50', 100]])
})

test('a baseline from another Node, OS or architecture is refused', () => {
  const current = { node: 'v24.22.1', arch: 'arm64', os: 'linux' }
  assertComparable(record([]), current)
  for (const machine of [{ node: 'v26.1.0' }, { arch: 'x64' }, { os: 'darwin' }]) {
    assert.throws(
      () => assertComparable(record([], machine), current),
      (error: unknown) => error instanceof BenchError && error.code === 'BENCH_BASELINE_INVALID',
    )
  }
})

test('a baseline with no count for any leg measured now is refused, not passed leg by leg', () => {
  // A --no-cachegrind record has results and no counts; a failed leg's count is no count.
  const wall = record([
    result('instructions/app-50', undefined),
    result('instructions/core', 7, false),
  ])
  assert.throws(() => assertBaselineCovers(wall, LEGS), code('BENCH_BASELINE_INVALID'))
  // Counts for other legs than the ones measured now (a --legs subset).
  const other = record([result('instructions/hoist', 5)])
  assert.throws(() => assertBaselineCovers(other, [suite, core]), code('BENCH_BASELINE_INVALID'))
  // One leg in common is enough: a leg added since the baseline is named, not refused.
  assertBaselineCovers(record([result('instructions/app-50', 5)]), [suite, core])
})

test('the legs the baseline has no count for are named as unjudged', () => {
  const comparisons = [
    compareLeg(suite, BASELINE, BASELINE),
    compareLeg(core, BASELINE, undefined),
    compareLeg(legOf('hoist') ?? core, undefined, BASELINE),
  ]
  assert.deepEqual(unjudgedLegs(comparisons), ['core'])
})

// What a counted record says it was counted with: the V8 flags and the valgrind options.
const COUNTING = {
  v8Flags: '--single-threaded --no-opt --predictable --no-incremental-marking-task',
  valgrindOptions: '--tool=cachegrind --cache-sim=no --trace-children=yes',
}

test('a counted record keeps valgrind’s version, its options and the V8 flags under machine.runners', () => {
  assert.deepEqual(countingRunners('3.19.0', COUNTING), {
    valgrind: '3.19.0',
    [COUNTING_KEYS.valgrindOptions]: COUNTING.valgrindOptions,
    [COUNTING_KEYS.v8Flags]: COUNTING.v8Flags,
  })
})

test('a baseline counted with the same V8 flags and valgrind options compares', () => {
  const baseline = record([], { runners: countingRunners('3.19.0', COUNTING) })
  assertSameCounting(baseline, COUNTING)
  // Another valgrind version is not a difference in how it counts.
  assertSameCounting(record([], { runners: countingRunners('3.22.0', COUNTING) }), COUNTING)
})

test('a baseline counted with other V8 flags or valgrind options is refused, naming both sets', () => {
  const old = { ...COUNTING, v8Flags: '--single-threaded --no-opt --predictable' }
  assert.throws(
    () => assertSameCounting(record([], { runners: countingRunners('3.19.0', old) }), COUNTING),
    (error: unknown) =>
      error instanceof BenchError &&
      error.code === 'BENCH_BASELINE_INVALID' &&
      error.message.includes(`"${old.v8Flags}" against "${COUNTING.v8Flags}"`),
  )
  const other = { ...COUNTING, valgrindOptions: '--tool=cachegrind --cache-sim=yes' }
  assert.throws(
    () => assertSameCounting(record([], { runners: countingRunners('3.19.0', other) }), COUNTING),
    (error: unknown) =>
      error instanceof BenchError &&
      error.code === 'BENCH_BASELINE_INVALID' &&
      error.message.includes(`"${other.valgrindOptions}" against "${COUNTING.valgrindOptions}"`),
  )
})

test('a baseline with no record of how it was counted is refused as predating the field', () => {
  // The old format: valgrind's version alone, or half the pair.
  for (const runners of [
    { valgrind: '3.19.0' },
    { valgrind: '3.19.0', [COUNTING_KEYS.v8Flags]: COUNTING.v8Flags },
    { valgrind: '3.19.0', [COUNTING_KEYS.valgrindOptions]: COUNTING.valgrindOptions },
  ]) {
    assert.throws(
      () => assertSameCounting(record([], { runners }), COUNTING),
      (error: unknown) =>
        error instanceof BenchError &&
        error.code === 'BENCH_BASELINE_INVALID' &&
        /predates the record of how it was counted/.test(error.message),
    )
  }
})
