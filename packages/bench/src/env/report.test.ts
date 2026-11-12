import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BenchError } from '../errors.ts'
import { failures, heapGrowthMb, parseBars, ratioOf } from './report.ts'

test('parseBars reads both bars, and none when absent', () => {
  assert.deepEqual(parseBars([]), {
    maxRatio: undefined,
    maxHeapMb: undefined,
    files: 100,
    rounds: 5,
  })
  assert.deepEqual(parseBars(['--max-ratio', '1.1', '--max-heap-mb', '10', '--files', '20']), {
    maxRatio: 1.1,
    maxHeapMb: 10,
    files: 20,
    rounds: 5,
  })
})

test('parseBars refuses a non-number, an unknown flag and a bad count', () => {
  for (const argv of [
    ['--max-ratio', 'fast'],
    ['--max-heap-mb', ''],
    ['--nope'],
    ['--files', '0'],
    ['--rounds', '1.5'],
  ]) {
    assert.throws(
      () => parseBars(argv),
      (error) => error instanceof BenchError && error.code === 'BENCH_USAGE',
      argv.join(' '),
    )
  }
})

test('ratioOf is ours over the baseline', () => {
  assert.equal(ratioOf({ ours: 11, baseline: 10 }), 1.1)
})

test('heapGrowthMb is the after-GC growth in megabytes', () => {
  assert.equal(heapGrowthMb(10 * 1024 * 1024, 15 * 1024 * 1024 + 512 * 1024), 5.5)
})

test('failures names each bar missed, and a NaN misses', () => {
  const bars = { maxRatio: 1.1, maxHeapMb: 10, files: 100, rounds: 5 }
  assert.deepEqual(failures({ ratio: 1.05, heapMb: 3 }, bars), [])
  assert.equal(failures({ ratio: 1.2, heapMb: 3 }, bars).length, 1)
  assert.equal(failures({ ratio: 1.05, heapMb: 11 }, bars).length, 1)
  assert.equal(failures({ ratio: Number.NaN, heapMb: Number.NaN }, bars).length, 2)
  // 1.1 exactly is within the bar, and a value that only rounds to it is not.
  assert.deepEqual(failures({ ratio: 1.1, heapMb: 10 }, bars), [])
  const near = failures({ ratio: 1.1000004, heapMb: 3 }, bars)
  assert.equal(near.length, 1)
  assert.doesNotMatch(near[0] ?? '', /is 1\.100 /)
  assert.deepEqual(
    failures(
      { ratio: 9, heapMb: 99 },
      { maxRatio: undefined, maxHeapMb: undefined, files: 1, rounds: 1 },
    ),
    [],
  )
})
