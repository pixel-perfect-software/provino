import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateTestFile, HOIST_CALL_PATTERN, seededRandom } from './generate.ts'
import {
  CALLS_PER_ROUND,
  CELLS,
  exitCodeFor,
  failures,
  keptMedian,
  medianSample,
  parseBars,
  ROUNDS,
  SEED,
  TARGET_BYTES,
  WARMUP_ROUNDS,
} from './report.ts'

const bars = { maxMockedMs: 10, maxUnmockedMs: 0.05 }

test('no flags is no bars; both flags parse as numbers', () => {
  assert.deepEqual(parseBars([]), { maxMockedMs: undefined, maxUnmockedMs: undefined })
  assert.deepEqual(parseBars(['--max-mocked-ms', '10', '--max-unmocked-ms', '0.05']), bars)
})

test('bad usage is a BENCH_USAGE error: a non-number bar or an unknown flag', () => {
  for (const argv of [['--max-mocked-ms', 'fast'], ['--max-unmocked-ms'], ['--nope', '1']]) {
    assert.throws(() => parseBars(argv), { name: 'BenchError', code: 'BENCH_USAGE' })
  }
})

test('the median of each cell is taken over the runs', () => {
  const med = medianSample([
    { mocked: 9, unmocked: 0.03 },
    { mocked: 3, unmocked: 0.01 },
    { mocked: 5, unmocked: 0.02 },
  ])
  assert.deepEqual(med, { mocked: 5, unmocked: 0.02 })
})

test('warm-up rounds are discarded before the median', () => {
  const perRound = [100, 100, 1, 2, 3, 4, 5, 6]
  assert.equal(perRound.length, ROUNDS)
  assert.equal(keptMedian(perRound), 3.5)
  assert.equal(WARMUP_ROUNDS, 2)
})

test('cells within the bars pass; no bars never fails', () => {
  assert.deepEqual(failures({ mocked: 4.2, unmocked: 0.03 }, bars), [])
  assert.deepEqual(
    failures({ mocked: 999, unmocked: 999 }, { maxMockedMs: undefined, maxUnmockedMs: undefined }),
    [],
  )
})

test('a cell over its bar is named, and only that cell', () => {
  const mocked = failures({ mocked: 12.5, unmocked: 0.03 }, bars)
  assert.equal(mocked.length, 1)
  assert.match(mocked[0] ?? '', /^FAIL mocked \(with mocks\) is 12\.500 ms; the bar is ≤ 10 ms/)
  const unmocked = failures({ mocked: 4, unmocked: 0.2 }, bars)
  assert.equal(unmocked.length, 1)
  assert.match(
    unmocked[0] ?? '',
    /^FAIL unmocked \(no mock call\) is 0\.200 ms; the bar is ≤ 0\.05 ms/,
  )
  assert.equal(exitCodeFor(mocked), 1)
  assert.equal(exitCodeFor(failures({ mocked: 4, unmocked: 0.03 }, bars)), 0)
  assert.equal(failures({ mocked: 12, unmocked: 0.2 }, bars).length, 2)
})

test('a failed value never prints equal to its bar, and a NaN misses', () => {
  const miss = failures({ mocked: 10.0004, unmocked: 0.01 }, bars)
  assert.match(miss[0] ?? '', /is 10\.0004 ms; the bar is ≤ 10 ms/)
  assert.equal(failures({ mocked: Number.NaN, unmocked: 0.01 }, bars).length, 1)
})

test('both cells have a call count, and the unmocked file is timed over many calls', () => {
  for (const cell of CELLS) assert.ok(CALLS_PER_ROUND[cell] >= 1)
  assert.ok(CALLS_PER_ROUND.unmocked > CALLS_PER_ROUND.mocked)
})

test('the seeded generator repeats itself, and a different seed does not', () => {
  const a = seededRandom(7)
  const b = seededRandom(7)
  assert.deepEqual([a(), a(), a()], [b(), b(), b()])
  assert.notEqual(seededRandom(8)(), seededRandom(7)())
})

test('the generated files are the same on every call and about 15 KB each', () => {
  const mocked = generateTestFile({ seed: SEED, mocked: true, targetBytes: TARGET_BYTES })
  const unmocked = generateTestFile({ seed: SEED, mocked: false, targetBytes: TARGET_BYTES })
  assert.equal(mocked, generateTestFile({ seed: SEED, mocked: true, targetBytes: TARGET_BYTES }))
  for (const text of [mocked, unmocked]) {
    assert.ok(text.length >= TARGET_BYTES && text.length < TARGET_BYTES + 1024, `${text.length}`)
  }
  assert.ok(Math.abs(mocked.length - unmocked.length) < 1024)
})

test('the mocked file has mock calls under many imports; the unmocked one has no hoistable call', () => {
  const mocked = generateTestFile({ seed: SEED, mocked: true, targetBytes: TARGET_BYTES })
  const unmocked = generateTestFile({ seed: SEED, mocked: false, targetBytes: TARGET_BYTES })
  assert.equal(mocked.match(/\bjest\.mock\(/g)?.length, 12)
  assert.equal(mocked.match(/^import /gm)?.length, 26)
  assert.match(mocked, HOIST_CALL_PATTERN)
  assert.doesNotMatch(unmocked, HOIST_CALL_PATTERN)
  assert.equal(unmocked.match(/^import /gm)?.length, 26)
})
