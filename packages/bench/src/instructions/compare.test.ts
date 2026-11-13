import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BenchRecord, BenchResult } from '@provino/types'
import { BenchError } from '../errors.ts'
import {
  anyRegressed,
  assertComparable,
  compareLeg,
  comparisonLines,
  countsOf,
  signedPercent,
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
