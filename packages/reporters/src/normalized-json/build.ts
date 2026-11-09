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
  TaskNode,
  TaskResult,
  TestStatus,
  TestTask,
} from '@provino/types'

/** What the reporter has seen of one file. */
export interface FileRecord {
  /** The file's tests in collection order; a test that ended without being collected is added. */
  readonly tests: Map<TaskId, TestTask>
  /** The `test-end` result of each test that ended. */
  readonly results: Map<TaskId, TaskResult>
  /** Unhandled errors the runtime tied to this file. */
  readonly unhandled: SerializedError[]
  /** Errors the runtime charged to a test after it ended (`errors.lateErrors: 'fail-owner'`). */
  readonly late: Map<TaskId, SerializedError[]>
  /** Errors of suites that ended `fail` (an `afterAll` that threw), which are in no file result. */
  readonly suiteErrors: SerializedError[]
  /** Real retries per test, counted from `test:attempt-end` events with `willRetry`. */
  readonly retries: Map<TaskId, number>
  /** The file's `console` events, in the order they came. */
  readonly console: RuntimeEventOf<'console'>[]
  /** Set by `file:end`. */
  ended: FileResult | undefined
}

/** A run-level error. `unhandled` ones are ignored for `success` when the policy says so. */
export interface RunError {
  readonly error: SerializedError
  readonly unhandled: boolean
}

/** What a run does about unhandled errors; the orchestrator's `unhandledErrors` policy. */
export type UnhandledErrors = 'fail-run' | 'ignore'

export function newFileRecord(): FileRecord {
  return {
    tests: new Map(),
    results: new Map(),
    unhandled: [],
    late: new Map(),
    suiteErrors: [],
    retries: new Map(),
    console: [],
    ended: undefined,
  }
}

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
  const file: ConsoleEntry[] = []
  const tests = new Map<TaskId, ConsoleEntry[]>()
  for (const write of record.console) {
    const entries = linesOf(write.text).map(
      (text): ConsoleEntry => ({
        stream: write.stream,
        text,
        ...(write.level === null ? {} : { level: write.level }),
      }),
    )
    const test = write.taskId === null ? undefined : record.tests.get(write.taskId)
    if (test === undefined) {
      file.push(...entries)
      continue
    }
    const existing = tests.get(test.id)
    if (existing === undefined) tests.set(test.id, entries)
    else existing.push(...entries)
  }
  return { file, tests }
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

/**
 * The tests of a collected tree in declaration order: a walk down from the file node, children in
 * order. The array is "parents before children", which is not necessarily declaration order.
 * Tests the walk doesn't reach are added at the end, in array order.
 */
export function testsInOrder(tasks: readonly TaskNode[]): TestTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const ordered: TestTask[] = []
  const seen = new Set<TaskId>()
  const visit = (task: TaskNode): void => {
    if (seen.has(task.id)) return
    seen.add(task.id)
    if (task.type === 'test') {
      ordered.push(task)
      return
    }
    for (const childId of task.children) {
      const child = byId.get(childId)
      if (child !== undefined) visit(child)
    }
  }
  for (const task of tasks) if (task.type === 'file') visit(task)
  for (const task of tasks) if (task.type === 'test' && !seen.has(task.id)) ordered.push(task)
  return ordered
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
  result: TaskResult | undefined,
  counted: number | undefined,
  console: readonly ConsoleEntry[] | undefined,
  late: readonly SerializedError[] = [],
): NormalizedTest {
  const retries = result === undefined ? undefined : retriesOf(test, result, counted)
  return {
    id: { file: info.path, path: [...test.fullName], dupIndex: test.dupIndex },
    // An error charged to the test after it ended fails it, whatever it ended as.
    status: late.length > 0 ? 'failed' : testStatus(result),
    ...(result?.skipReason === undefined || late.length > 0
      ? {}
      : { skipReason: result.skipReason }),
    errors: [...(result?.errors ?? []), ...late].map(normalizeError),
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
  const tests = [...record.tests.values()].map((test) =>
    normalizeTest(
      info,
      test,
      record.results.get(test.id),
      record.retries.get(test.id),
      console.tests.get(test.id),
      record.late.get(test.id),
    ),
  )
  const own = [...result.errors, ...record.suiteErrors]
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
    file: info.path,
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
