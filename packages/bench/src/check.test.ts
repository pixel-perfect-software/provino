import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkProblems, failureMessages, parseTestSummary } from './check.ts'

const passing = {
  numTotalTests: 40,
  numPassedTests: 40,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
}

test('the totals of a Jest or Vitest JSON report parse', () => {
  assert.deepEqual(parseTestSummary(passing), {
    total: 40,
    passed: 40,
    failed: 0,
    pending: 0,
    todo: 0,
    success: true,
  })
})

test('anything that is not a report parses to nothing', () => {
  assert.equal(parseTestSummary(undefined), undefined)
  assert.equal(parseTestSummary([]), undefined)
  assert.equal(parseTestSummary({ ...passing, numTotalTests: '40' }), undefined)
  assert.equal(parseTestSummary({ ...passing, success: 1 }), undefined)
  const { numTodoTests: _omitted, ...missing } = passing
  assert.equal(parseTestSummary(missing), undefined)
})

test('a clean run with the expected count has no problems', () => {
  assert.deepEqual(checkProblems(0, parseTestSummary(passing), 40), [])
})

test('every way a run can be wrong is named', () => {
  assert.deepEqual(checkProblems(1, parseTestSummary(passing), 40), ['exited 1'])
  assert.deepEqual(checkProblems(0, undefined, 40), ['wrote no readable JSON report'])
  assert.deepEqual(
    checkProblems(0, parseTestSummary({ ...passing, numTotalTests: 39, numPassedTests: 39 }), 40),
    ['ran 39 tests, expected 40', '39 tests passed, expected 40'],
  )
  assert.deepEqual(
    checkProblems(
      1,
      parseTestSummary({ ...passing, numFailedTests: 2, numPassedTests: 38, success: false }),
      40,
    ),
    ['exited 1', 'reported failure', '38 tests passed, expected 40', '2 tests failed'],
  )
  // skipped tests do not count as passed, so a suite that skips fails the check
  assert.deepEqual(
    checkProblems(0, parseTestSummary({ ...passing, numPassedTests: 39, numPendingTests: 1 }), 40),
    ['39 tests passed, expected 40'],
  )
})

test('failure messages name the file, the test and the first line, without colour codes', () => {
  const report = {
    testResults: [
      { name: '/s/tests/a.test.js', status: 'passed', assertionResults: [] },
      {
        name: '/s/tests/b.test.js',
        status: 'failed',
        assertionResults: [
          { fullName: 'b one', status: 'passed', failureMessages: [] },
          {
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
  assert.deepEqual(failureMessages(report), [
    '/s/tests/b.test.js > b two: Expected: 1',
    '/s/tests/c.test.js: Cannot find module x',
  ])
  assert.deepEqual(failureMessages(report, 1), ['/s/tests/b.test.js > b two: Expected: 1'])
  assert.deepEqual(failureMessages('nonsense'), [])
})
