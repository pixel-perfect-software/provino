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
   * Also compare each error's text with the golden's, in order and in number (under
   * `retry.keepEarlierErrors` a test's errors are every attempt's). Core's messages are neutral
   * except where a dialect owns the words (T5.7's `done` errors, the callable context), so only the
   * fixtures that exercise those, and the retry fixtures, ask. A timeout is a timeout: its text is
   * core's.
   */
  readonly compareMessages?: boolean
  /**
   * The golden's stderr is Jest's `logErrorsBeforeRetry` output: each test's earlier attempts'
   * errors (core's `retryErrors`) must be the ones Jest printed under its `LOGGING RETRY ERRORS`
   * header, and a test with none printed has none.
   */
  readonly retryLog?: boolean
  /**
   * A trace core is declared to give in place of the golden's (the fixture shows a bug in the real
   * runner that core does not copy, DIVERGENCES). Both sides are written out: the golden's trace
   * must still be the one the declaration was made against (a re-recorded golden can't keep the
   * exception alive), the declared one must differ from it (a declaration that no longer holds
   * fails), and core must give the declared one.
   */
  readonly declaredTrace?: DeclaredTrace
}

/** A declared difference in a fixture's trace. */
export interface DeclaredTrace {
  /** The trace the golden holds, which the declaration is a difference from. */
  readonly golden: readonly string[]
  /** The trace core gives instead. */
  readonly core: readonly string[]
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

  if (expected.declaredTrace === undefined) {
    assert.deepEqual(run.trace, golden.trace ?? [], 'trace')
  } else {
    const declared = expected.declaredTrace
    assert.deepEqual(
      golden.trace ?? [],
      declared.golden,
      "the golden's trace is not the one the declaration was made against: re-read the fixture and update the declaration",
    )
    assert.notDeepEqual(
      declared.core,
      declared.golden,
      'the declared trace now equals the golden: remove the declaration',
    )
    assert.deepEqual(run.trace, declared.core, 'the declared trace')
  }
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
  // Jest counts a test's invocations, so its `retries` are the attempts after the first. Vitest's
  // JSON has no count: its retries show in the trace.
  if (golden.runner === 'jest') {
    assert.deepEqual(
      run.tests.map((t) => ({ path: t.path, retries: Math.max(t.attempts - 1, 0) })),
      goldenFile.tests.map((t) => ({ path: t.id.path, retries: t.retries ?? 0 })),
      'tests: retries',
    )
  }
  if (expected.retryLog === true) {
    const logged = loggedRetryErrors(String(golden.observed?.stderr ?? ''))
    assert.deepEqual(
      run.tests.map((t) => ({
        path: t.path,
        retryErrors: t.retryErrors.map((e) => e.message),
      })),
      goldenFile.tests.map((t) => ({
        path: t.id.path,
        retryErrors: logged.get(t.id.path.join(' ')) ?? [],
      })),
      'tests: the errors logged before each retry',
    )
  }
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

/**
 * What Jest's default reporter logged for the retried tests: by the test's full name, the message
 * of each `RETRY n` block, in order (the first line below the heading, whatever follows it).
 */
export function loggedRetryErrors(stderr: string): ReadonlyMap<string, readonly string[]> {
  const logged = new Map<string, string[]>()
  let current: string[] | undefined
  let wantsMessage = false
  for (const line of stderr.split('\n')) {
    const header = /^ LOGGING RETRY ERRORS {2}(.*)$/.exec(line)
    if (header !== null) {
      current = []
      logged.set(header[1] ?? '', current)
      wantsMessage = false
    } else if (/^ RETRY \d+ *$/.test(line)) {
      wantsMessage = true
    } else if (wantsMessage && current !== undefined) {
      current.push(line.trim())
      wantsMessage = false
    }
  }
  return logged
}
