// What B07's corpus check asks of a run under `@provino/core`, given the golden recorded from the
// real runner (T5.3, T5.6). One function, so the comparison is itself under unit test.
import assert from 'node:assert/strict'
import type { CoreErrorCode } from '@provino/core'
import type { Golden } from '../golden.ts'
import { testKey } from '../normalize.ts'
import type { CoreRun } from './run-core.ts'

/** What the caller knows about the file beyond the golden. */
export interface GoldenExpectations {
  /** The test file's name in the fixture, which the golden's one file must carry. */
  readonly testFile: string
  /**
   * The `CoreError` code of the collection error, required for a file the golden records as
   * `crashed` (it fixes which check failed: core's messages are neutral, not the runner's text).
   */
  readonly collectionErrorCode?: CoreErrorCode
  /**
   * Also compare each error's text with the golden's. Core's messages are neutral except where a
   * dialect owns the words (T5.7's `done` errors, the callable context), so only the fixtures
   * that exercise those ask. A timeout is a timeout: its text is core's.
   */
  readonly compareMessages?: boolean
}

/** The golden's text for a Jest or Vitest timeout, which core words its own way. */
const TIMEOUT_TEXT = /^Error: (thrown: "Exceeded timeout|.* timed out in )/

/** An error as a golden prints it: `Name: message`, or `<timeout>` for a timeout. */
function printed(error: {
  readonly name: string
  readonly message: string
  readonly code?: string
}): string {
  return error.code === 'CORE_TIMEOUT' ? '<timeout>' : `${error.name}: ${error.message}`
}

/**
 * The tests a golden has no location for, as `testKey` prints them, in the golden's order.
 * `assertRunMatchesGolden` skips the location of such a test, so the caller names them and asserts
 * the list: a golden that loses its locations then fails instead of switching the comparison off.
 */
export function testsWithoutLocation(golden: Golden): string[] {
  return golden.files.flatMap((file) =>
    file.tests.filter((t) => t.location === undefined).map((t) => testKey(t.id)),
  )
}

/**
 * Asserts that `run` gives the golden's trace, tests (title path, `dupIndex`, status, location),
 * file status and where the errors are: which tests carry errors, and whether the file does (not
 * when a test failed, see below). Error text is not compared, only its presence, because core's
 * messages are deliberately neutral. A crashed file also has to fail for the cause the caller
 * names.
 */
export function assertRunMatchesGolden(
  run: CoreRun,
  golden: Golden,
  expected: GoldenExpectations,
): void {
  assert.equal(golden.files.length, 1, 'one golden file per profile')
  const [goldenFile] = golden.files
  assert.ok(goldenFile !== undefined)
  assert.equal(goldenFile.file, expected.testFile, "the golden's file is the test file")

  assert.deepEqual(run.trace, golden.trace ?? [], 'trace')
  assert.deepEqual(
    run.tests.map((t) => ({ path: t.path, dupIndex: t.dupIndex, status: t.status })),
    goldenFile.tests.map((t) => ({ path: t.id.path, dupIndex: t.id.dupIndex, status: t.status })),
    'tests: title path, dupIndex and status',
  )
  // Locations (line and column) where the golden has one. The tests it has none for are listed by
  // the caller (`testsWithoutLocation`): Jest's JSON drops the location of a test that timed out.
  assert.deepEqual(
    run.tests.map((t, index) =>
      goldenFile.tests[index]?.location === undefined ? null : t.location,
    ),
    goldenFile.tests.map((t) => t.location ?? null),
    'test locations',
  )
  assert.deepEqual(
    run.tests.map((t) => ({ path: t.path, hasErrors: t.errors.length > 0 })),
    goldenFile.tests.map((t) => ({ path: t.id.path, hasErrors: t.errors.length > 0 })),
    'tests: which carry errors',
  )
  if (expected.compareMessages === true) {
    assert.deepEqual(
      run.tests.map((t) => ({ path: t.path, messages: t.errors.map(printed) })),
      goldenFile.tests.map((t) => ({
        path: t.id.path,
        messages: t.errors.map((e) => (TIMEOUT_TEXT.test(e.message) ? '<timeout>' : e.message)),
      })),
      'tests: the text of each error',
    )
  }
  assert.equal(run.fileStatus, goldenFile.status, 'file status')
  // The converters keep `fileError` only for a file that failed outside its tests: when a test
  // failed, the file's message repeats that failure and is dropped (`assembleFile`). Such a golden
  // can't say whether the file also carries an error, so it is not compared.
  if (!goldenFile.tests.some((t) => t.status === 'failed')) {
    assert.equal(
      run.fileErrors.length > 0,
      goldenFile.fileError !== undefined,
      'whether the file carries an error',
    )
  }
  // A run that exits non-zero with nothing failed has an error of the run (Vitest charges a stray
  // timer or rejection there); one that exits 0 has none. When a task failed, the exit code says
  // nothing about it.
  const exitCode = golden.observed?.exitCode
  if (typeof exitCode === 'number') {
    const taskFailed =
      goldenFile.status === 'failed' || goldenFile.tests.some((t) => t.status === 'failed')
    const ofTheRun = run.unhandled.filter((item) => item.chargedTo === 'run')
    if (!taskFailed) {
      assert.equal(
        ofTheRun.length > 0,
        exitCode !== 0,
        'whether the run carries an error of its own',
      )
    }
    if (exitCode === 0) assert.deepEqual(run.unhandled, [], 'no error was charged to anything')
  }
  if (goldenFile.status === 'crashed') {
    assert.ok(
      expected.collectionErrorCode !== undefined,
      'the golden file crashed at collection, so the expectations must name the core error code',
    )
    assert.deepEqual(
      run.collectionErrors.map((error) => error.code),
      [expected.collectionErrorCode],
      'the collection error code',
    )
  }
}
