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

// What the real runners write: Jest 30.5.2's --json carries numTodoTests as well.
const realJest = JSON.stringify({
  ...envelope,
  numTodoTests: 0,
  numRuntimeErrorTestSuites: 0,
  wasInterrupted: false,
})

test('a real Jest --json file is not accepted as a Vitest report', () => {
  assert.equal(parseJestJson(realJest).testResults.length, 1)
  assert.throws(() => parseVitestJson(realJest, 'out.json'), invalid)
  for (const field of ['wasInterrupted', 'numRuntimeErrorTestSuites']) {
    assert.throws(
      () => parseVitestJson(JSON.stringify({ ...envelope, numTodoTests: 0, [field]: 0 })),
      invalid,
      field,
    )
  }
})

function withFileStatus(status: unknown, extra: object): string {
  return JSON.stringify({ ...envelope, ...extra, testResults: [{ ...file, status }] })
}

test("each guard checks a file's status against its runner's own set", () => {
  for (const status of ['passed', 'failed', 'skipped', 'focused']) {
    assert.equal(
      parseJestJson(withFileStatus(status, { wasInterrupted: false })).testResults.length,
      1,
    )
  }
  for (const status of ['passed', 'failed']) {
    assert.equal(parseVitestJson(withFileStatus(status, { numTodoTests: 0 })).testResults.length, 1)
  }
  for (const status of ['weird', '', 3, null]) {
    assert.throws(() => parseJestJson(withFileStatus(status, { wasInterrupted: false })), invalid)
    assert.throws(() => parseVitestJson(withFileStatus(status, { numTodoTests: 0 })), invalid)
  }
  for (const status of ['skipped', 'focused']) {
    assert.throws(() => parseVitestJson(withFileStatus(status, { numTodoTests: 0 })), invalid)
  }
})

function withFailureMessages(failureMessages: unknown, extra: object): string {
  const assertion = { title: 't', status: 'failed', ancestorTitles: [], failureMessages }
  return JSON.stringify({
    ...envelope,
    ...extra,
    testResults: [{ ...file, status: 'failed', assertionResults: [assertion] }],
  })
}

test('failureMessages may be absent, null, or an array of strings and nulls; nothing else', () => {
  const absent = JSON.stringify({
    ...envelope,
    numTodoTests: 0,
    testResults: [
      { ...file, assertionResults: [{ title: 't', status: 'failed', ancestorTitles: [] }] },
    ],
  })
  assert.equal(parseVitestJson(absent).testResults.length, 1)
  for (const messages of [null, [], ['boom'], [null], ['a', null, 'b']]) {
    assert.equal(
      parseVitestJson(withFailureMessages(messages, { numTodoTests: 0 })).testResults.length,
      1,
    )
    assert.equal(
      parseJestJson(withFailureMessages(messages, { wasInterrupted: false })).testResults.length,
      1,
    )
  }
  for (const messages of ['boom', 3, {}, [3], [{}], [['x']], [true]]) {
    assert.throws(
      () => parseVitestJson(withFailureMessages(messages, { numTodoTests: 0 })),
      invalid,
    )
    assert.throws(
      () => parseJestJson(withFailureMessages(messages, { wasInterrupted: false })),
      invalid,
    )
  }
})
