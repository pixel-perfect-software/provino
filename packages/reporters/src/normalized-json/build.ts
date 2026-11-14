import { stripVTControlCharacters } from 'node:util'
import type {
  ConsoleEntry,
  FileInfo,
  FileResult,
  FileStatus,
  NormalizedError,
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  RunEndReason,
  RunEnvironment,
  RuntimeEventOf,
  SerializedError,
  TaskId,
  TaskResult,
  TestStatus,
  TestTask,
} from '@provino/types'
import {
  type FileRecord,
  groupConsole,
  type Outcome,
  outcomeOf,
  type RunError,
  suiteErrorsOf,
} from '../internal/collect.ts'

/** What a run does about unhandled errors; the orchestrator's `unhandledErrors` policy. */
export type UnhandledErrors = 'fail-run' | 'ignore'

/**
 * A write as lines (the model has one entry per line): split on `\n`, with a trailing newline
 * ending the last line rather than starting an empty one, so `console.log('')` is one empty line.
 */
export function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The file's console output as the model has it: each write split into lines, given to the test
 * it ran in (its each-hooks included), or to the file when it ran in a suite's or the file's
 * `beforeAll`/`afterAll`, at the top level, or outside any task. Lines keep the order they came.
 */
function consoleOf(record: FileRecord): {
  readonly file: ConsoleEntry[]
  readonly tests: Map<TaskId, ConsoleEntry[]>
} {
  const grouped = groupConsole(record)
  const lines = (writes: readonly RuntimeEventOf<'console'>[]): ConsoleEntry[] =>
    writes.flatMap((write) =>
      linesOf(write.text).map(
        (text): ConsoleEntry => ({
          stream: write.stream,
          text,
          ...(write.level === null ? {} : { level: write.level }),
        }),
      ),
    )
  return {
    file: lines(grouped.file),
    tests: new Map([...grouped.tests].map(([id, writes]) => [id, lines(writes)])),
  }
}

/** Everything `buildNormalizedRun` needs. */
export interface RunParts {
  readonly runner: string
  readonly runnerVersion: string
  readonly suite: string
  readonly startedAt: string
  readonly env: RunEnvironment
  readonly files: ReadonlyMap<TaskId, FileRecord>
  readonly runErrors: readonly RunError[]
  readonly reason: RunEndReason
  /** Default `fail-run`. */
  readonly unhandledErrors?: UnhandledErrors
  /** The run's snapshot totals and files (`normalizeSnapshots`), when it had any. */
  readonly snapshots?: NormalizedRun['snapshots']
}

/** A thrown error as the model has it: no ANSI in `message`, the stack (else the message) as `raw`. */
export function normalizeError(error: SerializedError): NormalizedError {
  return {
    ...(error.name === '' ? {} : { name: error.name }),
    message: stripVTControlCharacters(error.message),
    ...(error.matcherResult === undefined ? {} : { matcher: error.matcherResult.name }),
    raw: error.stack ?? error.message,
  }
}

/** Several errors as one: the first's name and matcher, every message and raw text joined. */
function normalizeErrors(errors: readonly SerializedError[]): NormalizedError | undefined {
  const [first, ...rest] = errors.map(normalizeError)
  if (first === undefined) return undefined
  if (rest.length === 0) return first
  return {
    ...first,
    message: [first, ...rest].map((error) => error.message).join('\n'),
    raw: [first, ...rest].map((error) => error.raw).join('\n'),
  }
}

function testStatus(result: TaskResult | undefined): TestStatus {
  switch (result?.state) {
    case 'pass':
      return 'passed'
    case 'fail':
      return 'failed'
    case 'skip':
      return 'skipped'
    case 'todo':
      return 'todo'
    default:
      // Never started, or ended while still queued or running: it did not run.
      return 'notRun'
  }
}

/**
 * A test's real retries: the attempt events with `willRetry`. A repeat is also an attempt in
 * `TaskResult.attempts`, so that can't be used when the test repeated; without events, a test
 * that repeated has no `retries`.
 */
function retriesOf(
  test: TestTask,
  result: TaskResult,
  counted: number | undefined,
): number | undefined {
  if (counted !== undefined) return counted
  if (test.repeats > 0 || result.repeatIndex > 0) return undefined
  return result.attempts - 1
}

function normalizeTest(
  info: FileInfo,
  test: TestTask,
  outcome: Outcome,
  counted: number | undefined,
  console: readonly ConsoleEntry[] | undefined,
): NormalizedTest {
  const { result } = outcome
  const retries = result === undefined ? undefined : retriesOf(test, result, counted)
  return {
    id: { file: info.runPath ?? info.path, path: [...test.fullName], dupIndex: test.dupIndex },
    // An error charged to the test after it ended fails it, whatever it ended as.
    status: outcome.failed ? 'failed' : testStatus(result),
    ...(result?.skipReason === undefined || outcome.late.length > 0
      ? {}
      : { skipReason: result.skipReason }),
    errors: outcome.errors.map(normalizeError),
    ...(result === undefined ? {} : { passingAssertions: result.passingAssertions }),
    ...(retries === undefined || retries < 1 ? {} : { retries }),
    ...(result === undefined ? {} : { durationMs: result.durationMs }),
    ...(test.location === null
      ? {}
      : { location: { line: test.location.line, column: test.location.column } }),
    ...(console === undefined ? {} : { console }),
    ...(test.expectFail ? { expectedToFail: true } : {}),
  }
}

/**
 * One file's entry. Its status:
 * - `crashed` when its worker died, or it failed with no tests at all (a collection error);
 * - `skipped` / `passed` as the runtime said, unless an unhandled error was charged to it;
 * - otherwise `failed`.
 * A crashed or failed file keeps `fileError`: its own errors, and the unhandled ones charged to
 * it, except those already among its errors.
 */
function normalizeFile(
  info: FileInfo,
  record: FileRecord,
  result: FileResult,
  unhandledErrors: UnhandledErrors,
): NormalizedFile {
  const console = consoleOf(record)
  // A file failed whole after its tests ended (its inline snapshots could not be written) reports
  // none of them, as the Jest result it stands for has none.
  const kept = result.resultsDiscarded === true ? [] : [...record.tests.values()]
  const tests = kept.map((test) =>
    normalizeTest(
      info,
      test,
      outcomeOf(record, test),
      record.retries.get(test.id),
      console.tests.get(test.id),
    ),
  )
  const own = [...result.errors, ...suiteErrorsOf(record)]
  const known = new Set(own.map((error) => `${error.name}\0${error.message}`))
  const charged = record.unhandled.filter((error) => !known.has(`${error.name}\0${error.message}`))
  const errors = [...own, ...charged]
  // Under `ignore` an unhandled error is still recorded, but it fails nothing.
  const chargedFails = unhandledErrors === 'fail-run' && charged.length > 0
  const failedState = result.state === 'fail'
  let status: FileStatus
  if (result.workerExit !== undefined || (failedState && tests.length === 0)) status = 'crashed'
  else if (failedState || chargedFails || record.late.size > 0) status = 'failed'
  else if (result.state === 'skip') status = 'skipped'
  else status = 'passed'
  const fileError =
    status === 'crashed' || status === 'failed' || charged.length > 0
      ? normalizeErrors(errors)
      : undefined
  return {
    file: info.runPath ?? info.path,
    status,
    ...(fileError === undefined ? {} : { fileError }),
    tests,
    ...(console.file.length === 0 ? {} : { console: console.file }),
    durationMs: result.durationMs,
  }
}

/**
 * Builds the run: files sorted by path (they finish in any order), tests in collection order,
 * console output per test where a write names one and per file otherwise (`consoleOf`).
 * `trace` (T12.7) is left out. `snapshots` is what the run's snapshots were (the caller hashes the
 * files). `success` is false when a file failed or crashed, a run error was reported, the run
 * failed on its snapshots, or the run was interrupted. Under
 * `unhandledErrors: 'ignore'` unhandled errors are recorded but fail neither a file nor the run,
 * as the orchestrator's exit code has it.
 */
export function buildNormalizedRun(parts: RunParts): NormalizedRun {
  const unhandledErrors = parts.unhandledErrors ?? 'fail-run'
  const files: NormalizedFile[] = []
  for (const record of parts.files.values()) {
    if (record.ended !== undefined) {
      files.push(normalizeFile(record.ended.file, record, record.ended, unhandledErrors))
    }
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const runErrors = parts.runErrors.map(({ error }) => normalizeError(error))
  const failingRunErrors = parts.runErrors.some(
    ({ unhandled }) => !unhandled || unhandledErrors === 'fail-run',
  )
  const clean = files.every((file) => file.status !== 'failed' && file.status !== 'crashed')
  return {
    schemaVersion: 1,
    runner: parts.runner,
    runnerVersion: parts.runnerVersion,
    suite: parts.suite,
    startedAt: parts.startedAt,
    env: parts.env,
    files,
    ...(parts.snapshots === undefined ? {} : { snapshots: parts.snapshots }),
    runErrors,
    // `failed` also covers what no file shows: a run whose obsolete snapshots fail it.
    success: clean && !failingRunErrors && parts.reason === 'passed',
  }
}
