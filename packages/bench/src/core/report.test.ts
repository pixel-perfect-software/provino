import assert from 'node:assert/strict'
import { test } from 'provino'
import { BenchError } from '../errors.ts'
import {
  CORE_SETUPS,
  type CoreSample,
  coreConfigOf,
  coreFailures,
  medianCore,
  parseCoreFlags,
  turnsCost,
} from './report.ts'
import { CORE_TESTS, runCorePass } from './workload.ts'

const sample = (usPerTest: number, passed = CORE_TESTS): CoreSample => ({
  usPerTest,
  passed,
  eventsPerTest: 10,
})

test('flags: --max-us and --runs, with defaults', () => {
  assert.deepEqual(parseCoreFlags([]), { maxUs: undefined, runs: 5 })
  assert.deepEqual(parseCoreFlags(['--max-us', '5', '--runs', '3']), { maxUs: 5, runs: 3 })
})

test('flags: a bar that is not a number, a bad run count or an unknown flag is a usage error', () => {
  for (const argv of [['--max-us', 'five'], ['--runs', '0'], ['--runs', '1.5'], ['--fast']]) {
    assert.throws(
      () => parseCoreFlags(argv),
      (error: unknown) => error instanceof BenchError && error.code === 'BENCH_USAGE',
      argv.join(' '),
    )
  }
})

test('the median of the processes, and the fewest tests any of them passed', () => {
  assert.deepEqual(medianCore([sample(5), sample(4, 9_999), sample(6)]), {
    usPerTest: 5,
    passed: 9_999,
    eventsPerTest: 10,
  })
})

test('the bar is on locations off with no turns; locations on and the turns are signals with no bar', () => {
  assert.deepEqual(
    coreFailures({ off: sample(4.9), on: sample(12), turns: sample(8) }, CORE_TESTS, 5),
    [],
  )
  assert.deepEqual(
    coreFailures({ off: sample(5), on: sample(12), turns: sample(8) }, CORE_TESTS, 5),
    [],
  )
  const [miss] = coreFailures(
    { off: sample(5.004), on: sample(1), turns: sample(1) },
    CORE_TESTS,
    5,
  )
  // Never printed as "5.00", which would read as meeting the bar.
  assert.match(miss ?? '', /locations off \+ ALS: 5\.004 µs per test is over the bar of 5 µs/)
  assert.deepEqual(
    coreFailures({ off: sample(99), on: sample(99), turns: sample(99) }, CORE_TESTS, undefined),
    [],
  )
})

test('a measurement that is not a number misses the bar', () => {
  assert.equal(
    coreFailures({ off: sample(Number.NaN), on: sample(1), turns: sample(1) }, CORE_TESTS, 5)
      .length,
    1,
  )
})

test('every test must pass in every configuration, bar or not', () => {
  const missed = coreFailures(
    { off: sample(1, 3), on: sample(1, 4), turns: sample(1, 5) },
    CORE_TESTS,
    undefined,
  )
  assert.equal(missed.length, 3)
  assert.match(missed[0] ?? '', /locations off \+ ALS \(T5\.14\): 3\/10000 tests passed/)
  assert.match(missed[2] ?? '', /Jest's boundary turns \(signal\): 5\/10000 tests passed/)
})

test('the turns cost what the full Jest policy adds to the barred configuration', () => {
  assert.equal(turnsCost({ off: sample(4.5), on: sample(12), turns: sample(7.75) }), 3.25)
})

test('a child process takes off, on or turns, and the turns run with locations off', () => {
  assert.equal(coreConfigOf('turns'), 'turns')
  assert.deepEqual(CORE_SETUPS.turns, { locations: 'off', turns: 'jest' })
  assert.deepEqual(CORE_SETUPS.off, { locations: 'off', turns: 'none' })
  assert.throws(
    () => coreConfigOf('both'),
    (error: unknown) => error instanceof BenchError && error.code === 'BENCH_USAGE',
  )
})

test('the workload runs every test with its three hooks: 10 events per test', async () => {
  for (const [locations, turns] of [
    ['off', 'none'],
    ['on', 'none'],
    ['off', 'jest'],
  ] as const) {
    const pass = await runCorePass(locations, 50, turns)
    assert.equal(pass.passed, 50)
    // test-start, test-attempt-start, 3 × (hook-start, hook-end), test-attempt-end, test-end, plus
    // the file's own events.
    assert.equal(Math.floor(pass.events / 50), 10)
  }
})
