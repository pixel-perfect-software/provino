import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import { parseJestJson, parseVitestJson } from './parse-results.ts'

const file = {
  name: '/w/a.test.ts',
  message: '',
  status: 'passed',
  assertionResults: [{ title: 't', status: 'passed', ancestorTitles: [] }],
}
const envelope = {
  startTime: 1,
  success: true,
  numTotalTests: 1,
  snapshot: {},
  testResults: [file],
}
const jest = JSON.stringify({ ...envelope, wasInterrupted: false })
const vitest = JSON.stringify({ ...envelope, numTodoTests: 0 })

function invalid(error: unknown): boolean {
  return error instanceof HarnessError && error.code === 'HARNESS_RESULT_INVALID'
}

test("accepts each runner's own envelope", () => {
  assert.equal(parseJestJson(jest).testResults.length, 1)
  assert.equal(parseVitestJson(vitest).testResults.length, 1)
})

test("rejects the other runner's envelope, so a swapped output file is caught", () => {
  assert.throws(() => parseJestJson(vitest, 'out.json'), invalid)
  assert.throws(() => parseVitestJson(jest, 'out.json'), invalid)
})

test('rejects text that is not JSON and shapes that are not a run', () => {
  assert.throws(() => parseJestJson('{ nope'), invalid)
  assert.throws(() => parseJestJson('[]'), invalid)
  assert.throws(
    () =>
      parseVitestJson(JSON.stringify({ ...envelope, numTodoTests: 0, testResults: [{ name: 1 }] })),
    invalid,
  )
  assert.throws(
    () =>
      parseVitestJson(
        JSON.stringify({
          ...envelope,
          numTodoTests: 0,
          testResults: [{ ...file, assertionResults: [{}] }],
        }),
      ),
    invalid,
  )
})
