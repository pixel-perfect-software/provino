import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AggregatedResult,
  createEmptyTestResult,
  type FormattedTestResults,
  makeEmptyAggregatedTestResult,
} from '@jest/test-result'
import type { NormalizedTest } from '@provino/types'
import { convertJest } from './convert-jest.ts'
import { HarnessError } from './errors.ts'
import { testKey } from './normalize.ts'
import { parseJestJson } from './parse-results.ts'
import { convertOptions, ROOT, snapshotSummary } from './test-support.ts'

type FormattedFile = FormattedTestResults['testResults'][number]
type FormattedAssertion = FormattedFile['assertionResults'][number]

const FILE = `${ROOT}/a.test.ts`

const failure = [
  'Error: expect(received).toBe(expected) // Object.is equality',
  '',
  'Expected: 4',
  'Received: 3',
  `    at Object.toBe (${FILE}:7:23)`,
  '    at Promise.finally.completed (/repo/node_modules/jest-circus/build/jestAdapterInit.js:1:1)',
].join('\n')

function formattedAssertion(
  title: string,
  status: FormattedAssertion['status'],
  extra: Partial<FormattedAssertion> = {},
): FormattedAssertion {
  return {
    ancestorTitles: ['math'],
    fullName: `math ${title}`,
    status,
    title,
    failureMessages: [],
    location: { line: 3, column: 3 },
    duration: 1,
    ...extra,
  }
}

function formattedRun(files: FormattedFile[]): FormattedTestResults {
  return {
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 0,
    numPassedTests: 0,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numRuntimeErrorTestSuites: 0,
    numTotalTestSuites: files.length,
    numTotalTests: 0,
    snapshot: snapshotSummary(),
    startTime: Date.UTC(2026, 0, 2),
    success: files.every((f) => f.status !== 'failed'),
    testResults: files,
    wasInterrupted: false,
  }
}

function formattedFile(
  assertionResults: FormattedAssertion[],
  extra: Partial<FormattedFile> = {},
): FormattedFile {
  return {
    assertionResults,
    coverage: {},
    endTime: 1_010,
    message: '',
    name: FILE,
    startTime: 1_000,
    status: assertionResults.some((a) => a.status === 'failed') ? 'failed' : 'passed',
    summary: '',
    ...extra,
  }
}

function only(tests: readonly NormalizedTest[], index: number): NormalizedTest {
  const found = tests[index]
  assert.ok(found, `no test at ${index}`)
  return found
}

test('--json shape: maps statuses, paths, locations and errors', () => {
  const run = convertJest(
    formattedRun([
      formattedFile([
        formattedAssertion('passes', 'passed'),
        formattedAssertion('fails', 'failed', { failureMessages: [failure] }),
        formattedAssertion('skipped', 'pending', { duration: null }),
        formattedAssertion('todo', 'todo'),
      ]),
    ]),
    convertOptions(),
  )
  assert.equal(run.runner, 'jest')
  assert.equal(run.runnerVersion, '1.2.3')
  assert.equal(run.suite, 'unit/suite')
  assert.equal(run.startedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(run.success, false)
  const [file] = run.files
  assert.ok(file)
  assert.equal(file.file, 'a.test.ts')
  assert.equal(file.status, 'failed')
  assert.equal(file.durationMs, 10)
  assert.deepEqual(
    file.tests.map((t) => [t.id.path.join(' › '), t.status]),
    [
      ['math › passes', 'passed'],
      ['math › fails', 'failed'],
      ['math › skipped', 'skipped'],
      ['math › todo', 'todo'],
    ],
  )
  const failed = only(file.tests, 1)
  assert.deepEqual(failed.location, { line: 3, column: 3 })
  assert.equal(failed.errors[0]?.userFrame, '<root>/a.test.ts:7:23')
  assert.equal(only(file.tests, 2).skipReason, 'unknown')
  assert.equal('durationMs' in only(file.tests, 2), false)
})

test('--json shape: startedAt defaults to the run start time', () => {
  const { startedAt: _explicit, ...withoutStart } = convertOptions()
  const run = convertJest(formattedRun([]), withoutStart)
  assert.equal(run.startedAt, '2026-01-02T00:00:00.000Z')
})

test('reads numPassingAsserts and the matcher name when --json carries them', () => {
  const rich: FormattedAssertion = {
    ...formattedAssertion('fails', 'failed', { failureMessages: [failure] }),
    ...{
      numPassingAsserts: 2,
      failureDetails: [{ matcherResult: { name: 'toBe', pass: false } }],
    },
  }
  const run = convertJest(formattedRun([formattedFile([rich])]), convertOptions())
  const converted = only(run.files[0]?.tests ?? [], 0)
  assert.equal(converted.passingAssertions, 2)
  assert.equal(converted.errors[0]?.matcher, 'toBe')
})

test('tolerates failureDetails that are missing, short or not objects', () => {
  const odd: FormattedAssertion = {
    ...formattedAssertion('fails', 'failed', { failureMessages: [failure, failure, failure] }),
    ...{ failureDetails: [null, { matcherResult: 'nope' }] },
  }
  const run = convertJest(formattedRun([formattedFile([odd])]), convertOptions())
  const errors = only(run.files[0]?.tests ?? [], 0).errors
  assert.equal(errors.length, 3)
  assert.deepEqual(
    errors.map((e) => 'matcher' in e),
    [false, false, false],
  )
  assert.equal('passingAssertions' in only(run.files[0]?.tests ?? [], 0), false)
})

test('dupIndex counts earlier tests with the same file and path, per file', () => {
  const same = (title: string): FormattedAssertion => formattedAssertion(title, 'passed')
  const run = convertJest(
    formattedRun([
      formattedFile([same('twin'), same('other'), same('twin'), same('twin')], {
        name: `${ROOT}/b.test.ts`,
      }),
      formattedFile([same('twin')], { name: FILE }),
    ]),
    convertOptions(),
  )
  const byFile = Object.fromEntries(
    run.files.map((f) => [f.file, f.tests.map((t) => `${t.id.path.at(-1)}#${t.id.dupIndex}`)]),
  )
  assert.deepEqual(byFile, {
    'a.test.ts': ['twin#0'],
    'b.test.ts': ['twin#0', 'other#0', 'twin#1', 'twin#2'],
  })
  assert.deepEqual(
    run.files.map((f) => f.file),
    ['a.test.ts', 'b.test.ts'],
  )
})

test('a failed file with no tests is crashed and keeps its message as fileError', () => {
  const run = convertJest(
    formattedRun([
      formattedFile([], {
        status: 'failed',
        message: "  ● Test suite failed to run\n\n    Cannot find module './x' from 'a.test.ts'\n",
      }),
    ]),
    convertOptions(),
  )
  const [file] = run.files
  assert.equal(file?.status, 'crashed')
  assert.equal(file?.tests.length, 0)
  assert.match(file?.fileError?.message ?? '', /^● Test suite failed to run/)
})

test('a passed file with some pending tests (Jest "focused") is passed', () => {
  const run = convertJest(
    formattedRun([formattedFile([formattedAssertion('s', 'pending')], { status: 'focused' })]),
    convertOptions(),
  )
  assert.equal(run.files[0]?.status, 'passed')
})

test('legacy and unusual statuses map to skipped; an unknown one is a coded error', () => {
  const statuses = ['skipped', 'disabled', 'focused'] as const
  const run = convertJest(
    formattedRun([formattedFile(statuses.map((s) => formattedAssertion(s, s)))]),
    convertOptions(),
  )
  assert.deepEqual(
    run.files[0]?.tests.map((t) => t.status),
    ['skipped', 'skipped', 'skipped'],
  )
  // A status the types don't have can only arrive as parsed JSON.
  const json = JSON.stringify(
    formattedRun([formattedFile([formattedAssertion('x', 'passed')], { status: 'failed' })]),
  ).replace('"status":"passed"', '"status":"weird"')
  assert.throws(
    () => convertJest(parseJestJson(json), convertOptions()),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_UNKNOWN_STATUS',
  )
})

test('keeps retries and test.failing', () => {
  const run = convertJest(
    formattedRun([
      formattedFile([
        { ...formattedAssertion('flaky', 'passed'), ...{ invocations: 3 } },
        { ...formattedAssertion('inverted', 'passed'), ...{ failing: true, invocations: 1 } },
      ]),
    ]),
    convertOptions(),
  )
  const [flaky, inverted] = run.files[0]?.tests ?? []
  assert.equal(flaky?.retries, 2)
  assert.equal(inverted?.expectedToFail, true)
  assert.equal(inverted && 'retries' in inverted, false)
})

test('paths are POSIX and relative to rootDir, and the rules that fired are reported', () => {
  const fired = new Set<string>()
  const run = convertJest(
    formattedRun([
      formattedFile([formattedAssertion('fails', 'failed', { failureMessages: [failure] })], {
        name: `${ROOT}/sub/dir/c.test.ts`,
      }),
    ]),
    convertOptions({ fired }),
  )
  assert.equal(run.files[0]?.file, 'sub/dir/c.test.ts')
  assert.ok(fired.has('root'))
  assert.ok(fired.has('stack'))
})

test('reporter shape (AggregatedResult): testFilePath, testResults and testExecError', () => {
  const aggregated: AggregatedResult = {
    ...makeEmptyAggregatedTestResult(),
    startTime: Date.UTC(2026, 0, 3),
    success: false,
    testResults: [
      {
        ...createEmptyTestResult(),
        testFilePath: FILE,
        numFailingTests: 1,
        perfStats: { ...createEmptyTestResult().perfStats, start: 100, end: 160 },
        testResults: [
          {
            ancestorTitles: ['math'],
            failureDetails: [{ matcherResult: { name: 'toEqual' } }],
            failureMessages: [failure],
            fullName: 'math fails',
            numPassingAsserts: 1,
            status: 'failed',
            title: 'fails',
            location: { line: 5, column: 7 },
            duration: 2,
            invocations: 1,
          },
        ],
      },
      {
        ...createEmptyTestResult(),
        testFilePath: `${ROOT}/broken.test.ts`,
        testExecError: { message: 'SyntaxError: Unexpected token', stack: undefined },
        failureMessage: 'SyntaxError: Unexpected token ")"',
      },
      { ...createEmptyTestResult(), testFilePath: `${ROOT}/skipped.test.ts`, skipped: true },
    ],
    runExecError: {
      message: 'run failed',
      stack: 'Error: run failed\n    at x (/work/fixture/r.ts:1:1)',
    },
  }
  const { startedAt: _explicit, ...withoutStart } = convertOptions()
  const run = convertJest(aggregated, withoutStart)
  assert.deepEqual(
    run.files.map((f) => [f.file, f.status]),
    [
      ['a.test.ts', 'failed'],
      ['broken.test.ts', 'crashed'],
      ['skipped.test.ts', 'skipped'],
    ],
  )
  const [first, broken] = run.files
  assert.equal(first?.durationMs, 60)
  assert.equal(first?.tests[0]?.passingAssertions, 1)
  assert.equal(first?.tests[0]?.errors[0]?.matcher, 'toEqual')
  assert.equal(broken?.fileError?.message, 'SyntaxError: Unexpected token ")"')
  assert.equal(run.runErrors[0]?.message, 'Error: run failed')
  assert.equal(run.runErrors[0]?.userFrame, '<root>/r.ts:1:1')
  assert.equal(run.startedAt, '2026-01-03T00:00:00.000Z')
})

test('snapshot counters and the caller-supplied snapshot files are kept', () => {
  const summary = { ...snapshotSummary(), added: 2, matched: 3, total: 5, filesAdded: 1 }
  const input = { ...formattedRun([]), snapshot: summary }
  const run = convertJest(
    input,
    convertOptions({
      snapshotFiles: [
        { file: 'z.snap', sha256: 'bb' },
        { file: '__snapshots__/a.snap', sha256: 'aa' },
      ],
    }),
  )
  assert.equal(run.snapshots?.counters.added, 2)
  assert.equal(run.snapshots?.counters.filesAdded, 1)
  assert.deepEqual(
    run.snapshots?.files.map((f) => f.file),
    ['__snapshots__/a.snap', 'z.snap'],
  )
})

test('a describe path and a title that print the same get distinct test keys', () => {
  const run = convertJest(
    formattedRun([
      formattedFile([
        { ...formattedAssertion('b', 'passed'), ancestorTitles: ['a'] },
        { ...formattedAssertion('a › b', 'passed'), ancestorTitles: [] },
        { ...formattedAssertion('b', 'passed'), ancestorTitles: ['a'] },
      ]),
    ]),
    convertOptions(),
  )
  const keys = (run.files[0]?.tests ?? []).map((t) => testKey(t.id))
  assert.deepEqual(keys, ['a.test.ts::a › b#0', 'a.test.ts::a › b#1', 'a.test.ts::a › b#2'])
})

test('a null entry in failureMessages is one error with a placeholder message', () => {
  const json = JSON.stringify(
    formattedRun([
      formattedFile([
        formattedAssertion('throws an object', 'failed', { failureMessages: ['PLACEHOLDER'] }),
      ]),
    ]),
  ).replace('"PLACEHOLDER"', 'null')
  const run = convertJest(parseJestJson(json), convertOptions())
  const errors = run.files[0]?.tests[0]?.errors ?? []
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.message, '<no message>')
  assert.equal(errors[0]?.userFrame, undefined)
})

test('--json shape: a failed file whose tests all passed keeps its reason as fileError', () => {
  const run = convertJest(
    formattedRun([
      formattedFile([formattedAssertion('passes', 'passed')], {
        status: 'failed',
        message: '  ● Test suite failed to run\n\n    afterAll blew up\n',
      }),
    ]),
    convertOptions(),
  )
  const [file] = run.files
  assert.equal(file?.status, 'failed')
  assert.equal(file?.tests.length, 1)
  assert.equal(file?.fileError?.message, '● Test suite failed to run\n\n    afterAll blew up')
})

test('reporter shape: a file with an exec error and only passing tests keeps its reason', () => {
  const aggregated: AggregatedResult = {
    ...makeEmptyAggregatedTestResult(),
    success: false,
    testResults: [
      {
        ...createEmptyTestResult(),
        testFilePath: FILE,
        testExecError: { message: 'afterAll blew up', stack: undefined },
        testResults: [
          {
            ancestorTitles: [],
            failureDetails: [],
            failureMessages: [],
            fullName: 'passes',
            numPassingAsserts: 1,
            status: 'passed',
            title: 'passes',
            duration: 1,
            invocations: 1,
          },
        ],
      },
    ],
  }
  const file = convertJest(aggregated, convertOptions()).files[0]
  assert.equal(file?.status, 'failed')
  assert.equal(file?.fileError?.message, 'afterAll blew up')
})

test('a file with a failed test has no fileError, though its message repeats the failure', () => {
  const run = convertJest(
    formattedRun([
      formattedFile([formattedAssertion('fails', 'failed', { failureMessages: [failure] })], {
        message: `  ● math › fails\n\n    ${failure}\n`,
      }),
    ]),
    convertOptions(),
  )
  const file = run.files[0]
  assert.equal(file?.status, 'failed')
  assert.equal(file && 'fileError' in file, false)
})

test('a failed file whose message is empty has no fileError', () => {
  const run = convertJest(
    formattedRun([formattedFile([formattedAssertion('ok', 'passed')], { status: 'failed' })]),
    convertOptions(),
  )
  assert.equal(run.files[0] && 'fileError' in run.files[0], false)
})

test('a Windows rootDir makes Windows paths relative on any host', () => {
  const run = convertJest(
    formattedRun([
      formattedFile([formattedAssertion('t', 'passed')], {
        name: 'C:\\work\\fixture\\sub\\a.test.ts',
      }),
    ]),
    convertOptions({ rootDir: 'C:\\work\\fixture' }),
  )
  assert.equal(run.files[0]?.file, 'sub/a.test.ts')
})
