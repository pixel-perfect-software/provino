// T6.8's bar is a `local` measurement on a quiet machine; this checks the shape only, with a tiny
// workload and no bar. The bar run is `pnpm bench:lazy reads --max-ratio 3`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureReads, missesBar, parseReadsFlags } from './reads.ts'

test('the result is the one JSON line with its fields', async () => {
  const result = await measureReads({ rounds: 3, reads: 1000 })
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(result))), [
    'label',
    'node',
    'baselineNs',
    'lazyNs',
    'ratio',
  ])
  assert.equal(result.label, 'local')
  assert.equal(result.node, process.version)
  for (const value of [result.baselineNs, result.lazyNs, result.ratio]) {
    assert.ok(Number.isFinite(value) && value > 0, String(value))
  }
})

test('flags default to 3, 7 and 1,000,000 and reject what is not a number', () => {
  assert.deepEqual(parseReadsFlags([]), { maxRatio: 3, rounds: 7, reads: 1_000_000 })
  assert.deepEqual(parseReadsFlags(['--max-ratio', '2.5', '--rounds', '3', '--reads', '1000']), {
    maxRatio: 2.5,
    rounds: 3,
    reads: 1000,
  })
  assert.throws(() => parseReadsFlags(['--reads', '0']), /positive whole number/)
  assert.throws(() => parseReadsFlags(['--max-ratio', 'x']), /needs a number/)
})

test('a NaN ratio misses the bar', () => {
  const base = { label: 'local', node: 'v', baselineNs: 1, lazyNs: 1 } as const
  assert.equal(missesBar({ ...base, ratio: Number.NaN }, 3), true)
  assert.equal(missesBar({ ...base, ratio: 3 }, 3), false)
  assert.equal(missesBar({ ...base, ratio: 3.01 }, 3), true)
})
