import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  checkProblems,
  checkRunner,
  failureDetails,
  type Report,
  readReport,
  summarize,
} from './check.ts'
import { code, scratch } from './internal/test-helpers.ts'
import { DEFAULT_PATHS, parseSuiteName, writeSuite } from './suites.ts'

const passing: Report = {
  numTotalTests: 40,
  numPassedTests: 40,
  numFailedTests: 0,
  success: true,
  testResults: [],
}

test('the totals of a report are the ones the check judges', () => {
  assert.deepEqual(summarize(passing), { total: 40, passed: 40, failed: 0, success: true })
})

test('a clean run with the expected count has no problems', () => {
  assert.deepEqual(checkProblems(0, summarize(passing), 40), [])
})

test('every way a run can be wrong is named', () => {
  assert.deepEqual(checkProblems(1, summarize(passing), 40), ['exited 1'])
  assert.deepEqual(checkProblems(0, undefined, 40), ['wrote no readable JSON report'])
  assert.deepEqual(
    checkProblems(0, summarize({ ...passing, numTotalTests: 39, numPassedTests: 39 }), 40),
    ['ran 39 tests, expected 40', '39 tests passed, expected 40'],
  )
  assert.deepEqual(
    checkProblems(
      1,
      summarize({ ...passing, numFailedTests: 2, numPassedTests: 38, success: false }),
      40,
    ),
    ['exited 1', 'reported failure', '38 tests passed, expected 40', '2 tests failed'],
  )
  // skipped tests do not count as passed, so a suite that skips fails the check
  assert.deepEqual(checkProblems(0, summarize({ ...passing, numPassedTests: 39 }), 40), [
    '39 tests passed, expected 40',
  ])
})

test('failure details name the file, the test and the first line, without colour codes', () => {
  const report: Report = {
    ...passing,
    testResults: [
      { name: '/s/tests/a.test.js', status: 'passed', message: '', assertionResults: [] },
      {
        name: '/s/tests/b.test.js',
        status: 'failed',
        message: '',
        assertionResults: [
          { title: 'one', fullName: 'b one', status: 'passed', failureMessages: [] },
          {
            title: 'two',
            fullName: 'b two',
            status: 'failed',
            failureMessages: ['\u001b[31mExpected: 1\u001b[39m\nReceived: 2'],
          },
        ],
      },
      {
        name: '/s/tests/c.test.js',
        status: 'failed',
        message: '\nCannot find module x',
        assertionResults: [],
      },
    ],
  }
  assert.deepEqual(failureDetails(report), [
    '/s/tests/b.test.js > b two: Expected: 1',
    '/s/tests/c.test.js: Cannot find module x',
  ])
  assert.deepEqual(failureDetails(report, 1), ['/s/tests/b.test.js > b two: Expected: 1'])
})

test('a failed test with no message, or no full name, is still named', () => {
  const report: Report = {
    ...passing,
    testResults: [
      {
        name: '/s/tests/d.test.js',
        status: 'failed',
        message: '',
        assertionResults: [
          { title: 'bare', status: 'failed', failureMessages: null },
          { title: 'empty', fullName: 'd empty', status: 'failed', failureMessages: [null] },
        ],
      },
    ],
  }
  assert.deepEqual(failureDetails(report), [
    '/s/tests/d.test.js > bare: (no message)',
    '/s/tests/d.test.js > d empty: (no message)',
  ])
})

// The smallest envelope each runner's parser accepts. Jest's report also carries `wasInterrupted`;
// Vitest's carries `numTodoTests` and none of Jest's own fields.
const envelope = { ...passing, startTime: 0, snapshot: {} }
const jestReport = { ...envelope, wasInterrupted: false }
const vitestReport = { ...envelope, numTodoTests: 0 }

test('a report is read by the runner that wrote it', async (t) => {
  const dir = await scratch(t, 'bench-check-')
  await writeFile(join(dir, 'jest.json'), JSON.stringify(jestReport))
  await writeFile(join(dir, 'vitest.json'), JSON.stringify(vitestReport))
  const jest = await readReport('jest', join(dir, 'jest.json'))
  assert.ok(jest)
  assert.deepEqual(summarize(jest), { total: 40, passed: 40, failed: 0, success: true })
  const vitest = await readReport('vitest', join(dir, 'vitest.json'))
  assert.ok(vitest)
  assert.equal(vitest.numTotalTests, 40)
})

test('a report that is missing, broken or another runner’s reads as nothing', async (t) => {
  const dir = await scratch(t, 'bench-check-')
  await writeFile(join(dir, 'jest.json'), JSON.stringify(jestReport))
  await writeFile(join(dir, 'vitest.json'), JSON.stringify(vitestReport))
  await writeFile(join(dir, 'broken.json'), '{"numTotalTests": 4')
  await writeFile(join(dir, 'list.json'), '[]')
  assert.equal(await readReport('jest', join(dir, 'missing.json')), undefined)
  assert.equal(await readReport('jest', join(dir, 'broken.json')), undefined)
  assert.equal(await readReport('jest', join(dir, 'list.json')), undefined)
  assert.equal(await readReport('jest', join(dir, 'vitest.json')), undefined)
  assert.equal(await readReport('vitest', join(dir, 'jest.json')), undefined)
})

test('a report that cannot be read for another reason is an error, not a missing report', async (t) => {
  const dir = await scratch(t, 'bench-check-')
  await mkdir(join(dir, 'a-directory'))
  await assert.rejects(readReport('jest', join(dir, 'a-directory')), { code: 'EISDIR' })
})

test('a run past its timeout fails the check as exit 124 and names the timeout', async (t) => {
  const root = await scratch(t, 'bench-check-')
  const spec = parseSuiteName('app-1')
  await writeSuite(spec, root)
  // One millisecond is less than any runner needs to start, so the run is killed before it can
  // write a report.
  const result = await checkRunner(spec, 'jest', {
    paths: { ...DEFAULT_PATHS, suitesRoot: root },
    timeoutMs: 1,
  })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 124)
  assert.equal(result.summary, undefined)
  assert.deepEqual(result.problems, [
    'exited 124',
    'wrote no readable JSON report',
    'timed out after 0.001 s and was killed',
  ])
  assert.ok(result.wallMs < 10_000, `wall ${result.wallMs} ms`)
})

test('a timeout outside what a timer can hold is refused before anything runs', async (t) => {
  const root = await scratch(t, 'bench-check-')
  for (const timeoutMs of [0, 1.5, Number.NaN, 2 ** 31]) {
    await assert.rejects(
      checkRunner(parseSuiteName('app-1'), 'jest', {
        paths: { ...DEFAULT_PATHS, suitesRoot: root },
        timeoutMs,
      }),
      code('BENCH_INVALID_SPEC'),
      String(timeoutMs),
    )
  }
})
