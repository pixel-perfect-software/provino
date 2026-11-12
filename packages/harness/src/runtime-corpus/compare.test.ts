// `assertRunMatchesGolden` against hand-built runs and goldens: each case changes one thing from a
// matching pair and says which part of the comparison has to notice.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SerializedError } from '@provino/types'
import { type Golden, toGolden } from '../golden.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import { assertRunMatchesGolden, type GoldenExpectations, testsWithoutLocation } from './compare.ts'
import type { CoreRun, CoreTest } from './run-core.ts'

const FILE = 'a.test.ts'
const boom: SerializedError = { name: 'Error', message: 'boom' }
const goldenBoom = { message: 'boom', raw: '' }

function coreTest(name: string, overrides: Partial<CoreTest> = {}): CoreTest {
  return { path: [name], dupIndex: 0, status: 'passed', location: null, errors: [], ...overrides }
}

function coreRun(overrides: Partial<CoreRun> = {}): CoreRun {
  return {
    trace: [],
    tests: [coreTest('one')],
    fileStatus: 'passed',
    fileErrors: [],
    collectionErrors: [],
    unhandled: [],
    ...overrides,
  }
}

/** A golden with the one file `a.test.ts`. */
function golden(
  file: Parameters<typeof makeFile>[1],
  options: { status?: Parameters<typeof makeFile>[2]; fileError?: boolean; trace?: string[] } = {},
): Golden {
  const base = makeFile(FILE, file, options.status)
  const withError = options.fileError === true ? { ...base, fileError: goldenBoom } : base
  return toGolden(makeRun([withError]), options.trace === undefined ? {} : { trace: options.trace })
}

const matching = golden([makeTest(FILE, ['one'])])
const expected: GoldenExpectations = { testFile: FILE }

function mismatch(run: CoreRun, against: Golden, what: RegExp, wanted = expected): void {
  assert.throws(() => assertRunMatchesGolden(run, against, wanted), what)
}

test('a run that gives the golden’s trace, tests and file status matches', () => {
  assertRunMatchesGolden(coreRun(), matching, expected)
  assertRunMatchesGolden(
    coreRun({ trace: ['a', 'b'] }),
    golden([makeTest(FILE, ['one'])], { trace: ['a', 'b'] }),
    expected,
  )
})

test('the golden must be one file, and the test file’s', () => {
  mismatch(coreRun(), golden([makeTest(FILE, ['one'])]), /file is the test file/, {
    testFile: 'b.test.ts',
  })
  const two = toGolden(
    makeRun([makeFile(FILE, [makeTest(FILE, ['one'])]), makeFile('b.test.ts', [])]),
  )
  mismatch(coreRun(), two, /one golden file per profile/)
})

test('the trace, a test’s path and status, and the file status are compared', () => {
  mismatch(coreRun({ trace: ['x'] }), matching, /trace/)
  mismatch(coreRun({ tests: [coreTest('two')] }), matching, /title path, dupIndex and status/)
  mismatch(
    coreRun({ tests: [coreTest('one', { status: 'skipped' })] }),
    matching,
    /title path, dupIndex and status/,
  )
  mismatch(coreRun({ fileStatus: 'failed' }), matching, /file status/)
})

test('a test the core never ended is not a skipped one', () => {
  const skipped = golden([makeTest(FILE, ['one'], { status: 'skipped' })])
  assertRunMatchesGolden(
    coreRun({ tests: [coreTest('one', { status: 'skipped' })] }),
    skipped,
    expected,
  )
  mismatch(
    coreRun({ tests: [coreTest('one', { status: 'no-result' })] }),
    skipped,
    /title path, dupIndex and status/,
  )
  mismatch(coreRun({ fileStatus: 'no-result' }), matching, /file status/)
})

test('a location is compared where the golden has one, and ignored where it has none', () => {
  const located = golden([{ ...makeTest(FILE, ['one']), location: { line: 2, column: 3 } }])
  const at = (line: number): CoreRun =>
    coreRun({ tests: [coreTest('one', { location: { line, column: 3 } })] })
  assertRunMatchesGolden(at(2), located, expected)
  mismatch(at(9), located, /test locations/)
  assertRunMatchesGolden(at(9), matching, expected)
})

test('the tests a golden has no location for are listed by their keys', () => {
  const mixed = golden([
    { ...makeTest(FILE, ['one']), location: { line: 2, column: 3 } },
    makeTest(FILE, ['group', 'two']),
    makeTest(FILE, ['dup'], { dupIndex: 1 }),
  ])
  assert.deepEqual(testsWithoutLocation(mixed), [`${FILE}::group › two#0`, `${FILE}::dup#1`])
  assert.deepEqual(
    testsWithoutLocation(
      golden([{ ...makeTest(FILE, ['one']), location: { line: 2, column: 3 } }]),
    ),
    [],
  )
  assert.deepEqual(testsWithoutLocation(golden([], { status: 'crashed' })), [])
})

test('which tests carry errors is compared, in both directions', () => {
  const failing = golden([makeTest(FILE, ['one'], { status: 'failed', errors: [goldenBoom] })])
  const failed = (errors: readonly SerializedError[]): CoreRun =>
    coreRun({ tests: [coreTest('one', { status: 'failed', errors })], fileStatus: 'failed' })
  assertRunMatchesGolden(failed([boom]), failing, expected)
  // The text is not compared: core's messages are neutral.
  assertRunMatchesGolden(failed([{ name: 'CoreError', message: 'other words' }]), failing, expected)
  mismatch(failed([]), failing, /which carry errors/)
  mismatch(
    coreRun({ tests: [coreTest('one', { errors: [boom] })] }),
    matching,
    /which carry errors/,
  )
})

test('an error on a skipped test is placed, not lost', () => {
  const skippedWithError = golden([
    makeTest(FILE, ['one'], { status: 'skipped', errors: [goldenBoom] }),
  ])
  const skipped = (errors: readonly SerializedError[]): CoreRun =>
    coreRun({ tests: [coreTest('one', { status: 'skipped', errors })] })
  assertRunMatchesGolden(skipped([boom]), skippedWithError, expected)
  mismatch(skipped([]), skippedWithError, /which carry errors/)
})

test('whether the file carries an error is compared, in both directions', () => {
  const withFileError = golden([makeTest(FILE, ['one'])], { status: 'failed', fileError: true })
  const failedFile = (fileErrors: readonly SerializedError[]): CoreRun =>
    coreRun({ fileStatus: 'failed', fileErrors })
  assertRunMatchesGolden(failedFile([boom]), withFileError, expected)
  mismatch(failedFile([]), withFileError, /file carries an error/)
  mismatch(
    failedFile([boom]),
    golden([makeTest(FILE, ['one'])], { status: 'failed' }),
    /file carries an error/,
  )
})

test('a golden with a failed test cannot say whether the file also carries an error', () => {
  // The converters drop a file message that repeats a failed test, so there is no `fileError`.
  const failing = golden([makeTest(FILE, ['one'], { status: 'failed', errors: [goldenBoom] })])
  const failed = (fileErrors: readonly SerializedError[]): CoreRun =>
    coreRun({
      tests: [coreTest('one', { status: 'failed', errors: [boom] })],
      fileStatus: 'failed',
      fileErrors,
    })
  assertRunMatchesGolden(failed([]), failing, expected)
  assertRunMatchesGolden(failed([boom]), failing, expected)
})

test('a crashed file must fail at collection with the expected core error code', () => {
  const crashed = golden([], { status: 'crashed', fileError: true })
  const crash = (...codes: Array<string | undefined>): CoreRun =>
    coreRun({
      tests: [],
      fileStatus: 'crashed',
      fileErrors: [boom],
      collectionErrors: codes.map((code) => ({
        name: 'CoreError',
        message: 'neutral words',
        ...(code === undefined ? {} : { code }),
      })),
    })
  const wanted: GoldenExpectations = { testFile: FILE, collectionErrorCode: 'CORE_MISSING_TEST_FN' }
  assertRunMatchesGolden(crash('CORE_MISSING_TEST_FN'), crashed, wanted)
  mismatch(crash('CORE_ASYNC_DESCRIBE'), crashed, /collection error code/, wanted)
  mismatch(crash(undefined), crashed, /collection error code/, wanted)
  mismatch(crash(), crashed, /collection error code/, wanted)
  mismatch(
    crash('CORE_MISSING_TEST_FN', 'CORE_ASYNC_DESCRIBE'),
    crashed,
    /collection error code/,
    wanted,
  )
  // A crash the expectations do not name a code for is not accepted as "some crash".
  mismatch(crash('CORE_MISSING_TEST_FN'), crashed, /must name the core error code/)
})

test('the collection error code is asked of a crashed file only', () => {
  assertRunMatchesGolden(coreRun(), matching, {
    testFile: FILE,
    collectionErrorCode: 'CORE_MISSING_TEST_FN',
  })
})
