import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JsonTestResults } from 'vitest/node'
import { convertVitest } from './convert-vitest.ts'
import { HarnessError } from './errors.ts'
import { parseVitestJson } from './parse-results.ts'
import { convertOptions, ROOT, snapshotSummary } from './test-support.ts'

type File = JsonTestResults['testResults'][number]
type Assertion = File['assertionResults'][number]

const FILE = `${ROOT}/a.test.ts`

const failure = [
  'AssertionError: expected 3 to be 4 // Object.is equality',
  `    at ${FILE}:7:23`,
  '    at file:///repo/node_modules/.pnpm/vitest@5.0.5/node_modules/vitest/dist/chunks/run.js:1632:35',
].join('\n')

function assertion(
  title: string,
  status: Assertion['status'],
  extra: Partial<Assertion> = {},
): Assertion {
  return {
    ancestorTitles: ['math'],
    fullName: `math ${title}`,
    status,
    title,
    meta: {},
    failureMessages: [],
    location: { line: 3, column: 3 },
    tags: [],
    benchmarks: [],
    ...extra,
  }
}

function file(assertionResults: Assertion[], extra: Partial<File> = {}): File {
  return {
    assertionResults,
    endTime: 2_005,
    message: '',
    name: FILE,
    startTime: 2_000,
    status: assertionResults.some((a) => a.status === 'failed') ? 'failed' : 'passed',
    ...extra,
  }
}

function run(files: File[]): JsonTestResults {
  return {
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 0,
    numPassedTests: 0,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: files.length,
    numTotalTests: 0,
    snapshot: snapshotSummary(),
    startTime: Date.UTC(2026, 0, 2),
    success: files.every((f) => f.status === 'passed'),
    testResults: files,
  }
}

test('maps the five Vitest statuses; pending becomes notRun', () => {
  const converted = convertVitest(
    run([
      file([
        assertion('passes', 'passed', { duration: 0.76 }),
        assertion('fails', 'failed', { failureMessages: [failure] }),
        assertion('skipped', 'skipped'),
        assertion('todo', 'todo'),
        assertion('never started', 'pending'),
        assertion('disabled', 'disabled'),
      ]),
    ]),
    convertOptions(),
  )
  assert.equal(converted.runner, 'vitest')
  assert.deepEqual(
    converted.files[0]?.tests.map((t) => t.status),
    ['passed', 'failed', 'skipped', 'todo', 'notRun', 'skipped'],
  )
  const tests = converted.files[0]?.tests ?? []
  assert.equal(tests[0]?.durationMs, 0.76)
  assert.equal(tests[2]?.skipReason, 'unknown')
  assert.equal(tests[4] && 'skipReason' in tests[4], false)
  assert.deepEqual(tests[1]?.location, { line: 3, column: 3 })
})

test('splits the failure into message and user frame; there is no matcher name', () => {
  const converted = convertVitest(
    run([file([assertion('fails', 'failed', { failureMessages: [failure, failure] })])]),
    convertOptions(),
  )
  const errors = converted.files[0]?.tests[0]?.errors ?? []
  assert.equal(errors.length, 2)
  assert.equal(errors[0]?.name, 'AssertionError')
  assert.equal(errors[0]?.message, 'AssertionError: expected 3 to be 4 // Object.is equality')
  assert.equal(errors[0]?.userFrame, '<root>/a.test.ts:7:23')
  assert.equal(errors[0] && 'matcher' in errors[0], false)
  assert.equal(converted.files[0]?.tests[0]?.passingAssertions, undefined)
})

test('null failureMessages and a null location are tolerated', () => {
  const converted = convertVitest(
    run([file([assertion('odd', 'failed', { failureMessages: null, location: null })])]),
    convertOptions(),
  )
  const [t] = converted.files[0]?.tests ?? []
  assert.deepEqual(t?.errors, [])
  assert.equal(t && 'location' in t, false)
})

test('dupIndex counts same-titled tests per file, in order', () => {
  const converted = convertVitest(
    run([
      file([assertion('twin', 'passed'), assertion('twin', 'passed'), assertion('solo', 'passed')]),
    ]),
    convertOptions(),
  )
  assert.deepEqual(
    converted.files[0]?.tests.map((t) => t.id.dupIndex),
    [0, 1, 0],
  )
})

test('a failed file with no tests is crashed and keeps its message as fileError', () => {
  const converted = convertVitest(
    run([
      file([], {
        status: 'failed',
        message: `Error: Failed to load url ./x (resolved id: ./x) in ${FILE}. Does the file exist?`,
      }),
      file([], { status: 'passed', name: `${ROOT}/empty.test.ts` }),
    ]),
    convertOptions(),
  )
  const [crashed, empty] = converted.files
  assert.equal(crashed?.file, 'a.test.ts')
  assert.equal(crashed?.status, 'crashed')
  assert.equal(
    crashed?.fileError?.message,
    'Error: Failed to load url ./x (resolved id: ./x) in <root>/a.test.ts. Does the file exist?',
  )
  assert.equal(empty?.status, 'passed')
  assert.equal(empty && 'fileError' in empty, false)
})

test('an unknown status is a coded error', () => {
  const json = JSON.stringify(
    run([file([assertion('x', 'passed')], { status: 'failed' })]),
  ).replace('"status":"passed"', '"status":"weird"')
  assert.throws(
    () => convertVitest(parseVitestJson(json), convertOptions()),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_UNKNOWN_STATUS',
  )
})

test('startedAt defaults to the run start time; counters come from the snapshot summary', () => {
  const { startedAt: _explicit, ...withoutStart } = convertOptions()
  const converted = convertVitest(
    { ...run([]), snapshot: { ...snapshotSummary(), unmatched: 1, total: 4 } },
    withoutStart,
  )
  assert.equal(converted.startedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(converted.snapshots?.counters.unmatched, 1)
  assert.equal(converted.snapshots?.counters.total, 4)
  assert.deepEqual(converted.runErrors, [])
})
