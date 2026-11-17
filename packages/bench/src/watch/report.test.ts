import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BenchError } from '../errors.ts'
import { filesNote, parseProbeLine, parseWatchFlags, watchFailures, watchLines } from './report.ts'

test('flags: the bar, saves, runner and sizes, with defaults', () => {
  assert.deepEqual(parseWatchFlags([]), {
    maxMs: undefined,
    saves: 20,
    withJest: false,
    sessions: 1,
    files: 5_000,
    settleMs: 250,
    keep: false,
  })
  const flags = parseWatchFlags([
    '--max-ms',
    '150',
    '--runner',
    'jest',
    '--files',
    '50',
    '--saves',
    '2',
  ])
  assert.equal(flags.maxMs, 150)
  assert.equal(flags.withJest, true)
  assert.equal(flags.sessions, 2, 'with Jest there is something to interleave')
  assert.equal(flags.files, 50)
  assert.equal(flags.saves, 2)
})

test('flags: bad values and unknown flags are usage errors', () => {
  for (const argv of [
    ['--max-ms', 'fast'],
    ['--saves', '0'],
    ['--runner', 'vitest'],
    ['--files', '1'],
    ['--sessions', '1.5'],
    ['--settle-ms', '-1'],
    ['--nope'],
  ]) {
    assert.throws(
      () => parseWatchFlags(argv),
      (error: unknown) => error instanceof BenchError && error.code === 'BENCH_USAGE',
      argv.join(' '),
    )
  }
  assert.equal(parseWatchFlags(['--settle-ms', '0']).settleMs, 0)
})

test('the probe line: a kind and a time; anything else on the descriptor is ignored', () => {
  assert.deepEqual(parseProbeLine('start 1763400000123.5'), { kind: 'start', at: 1763400000123.5 })
  assert.deepEqual(parseProbeLine('done 17'), { kind: 'done', at: 17 })
  assert.equal(parseProbeLine('begin 17'), undefined)
  assert.equal(parseProbeLine('start soon'), undefined)
  assert.equal(parseProbeLine(''), undefined)
})

test('the header names a tree that is not the size asked for, and says nothing otherwise', () => {
  assert.equal(filesNote(5_000, 5_000), undefined)
  assert.match(filesNote(105, 100) ?? '', /--files 105 .* the tree has 100 files/)
})

test('the bar is on Provino alone, on the median, and never reads a miss as a tie', () => {
  const ok = { provino: [140, 150, 160], jest: [400, 500, 600] }
  assert.deepEqual(watchFailures(ok, 3, 150), [])
  assert.deepEqual(watchFailures(ok, 3, undefined), [])
  const [miss] = watchFailures({ provino: [150.004], jest: [] }, 1, 150)
  assert.match(miss ?? '', /median 150\.004 ms .* over the bar of 150 ms/)
  // A sample that is not a number stops the run in the stats, it is never a pass.
  assert.throws(() => watchFailures({ provino: [Number.NaN], jest: [] }, 1, 150), BenchError)
})

test('every save of every subject that ran must have been measured', () => {
  assert.equal(watchFailures({ provino: [1], jest: [] }, 2, undefined).length, 1)
  assert.equal(watchFailures({ provino: [1, 2], jest: [1] }, 2, undefined).length, 1)
  assert.equal(watchFailures({ provino: [1, 2], jest: [] }, 2, undefined).length, 0)
})

test('the lines name each subject, its median and the ratio against Jest', () => {
  const flags = parseWatchFlags(['--runner', 'jest', '--max-ms', '150'])
  const lines = watchLines({ provino: [100, 120], jest: [200, 240] }, flags, {
    provino: 'provino jest --watch',
    jest: 'jest 30.5.2 --watch',
  })
  assert.match(lines.join('\n'), /provino jest --watch\s+median\s+110\.0 ms.*2 saves/)
  assert.match(lines.join('\n'), /jest 30\.5\.2 --watch\s+median\s+220\.0 ms/)
  assert.match(lines.join('\n'), /ratio provino\/jest: 0\.500/)
  assert.match(lines.join('\n'), /bar: median ≤150 ms/)
})
