import { stripVTControlCharacters } from 'node:util'
import type {
  FileInfo,
  FileResult,
  FileStatus,
  NormalizedError,
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  RunEndReason,
  RunEnvironment,
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
  /** Set by `file:end`. */
  ended: FileResult | undefined
}

export function newFileRecord(): FileRecord {
  return { tests: new Map(), results: new Map(), unhandled: [], ended: undefined }
}

/** Everything `buildNormalizedRun` needs. */
export interface RunParts {
  readonly runner: string
  readonly runnerVersion: string
  readonly suite: string
  readonly startedAt: string
  readonly env: RunEnvironment
  readonly files: ReadonlyMap<TaskId, FileRecord>
  readonly runErrors: readonly SerializedError[]
  readonly reason: RunEndReason
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

function normalizeTest(
  info: FileInfo,
  test: TestTask,
  result: TaskResult | undefined,
): NormalizedTest {
  return {
    id: { file: info.path, path: [...test.fullName], dupIndex: test.dupIndex },
    status: testStatus(result),
    ...(result?.skipReason === undefined ? {} : { skipReason: result.skipReason }),
    errors: (result?.errors ?? []).map(normalizeError),
    ...(result === undefined ? {} : { passingAssertions: result.passingAssertions }),
    ...(result !== undefined && result.attempts > 1 ? { retries: result.attempts - 1 } : {}),
    ...(result === undefined ? {} : { durationMs: result.durationMs }),
    ...(test.location === null
      ? {}
      : { location: { line: test.location.line, column: test.location.column } }),
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
function normalizeFile(info: FileInfo, record: FileRecord, result: FileResult): NormalizedFile {
  const tests = [...record.tests.values()].map((test) =>
    normalizeTest(info, test, record.results.get(test.id)),
  )
  const known = new Set(result.errors.map((error) => `${error.name}\0${error.message}`))
  const charged = record.unhandled.filter((error) => !known.has(`${error.name}\0${error.message}`))
  const errors = [...result.errors, ...charged]
  const failedState = result.state === 'fail'
  let status: FileStatus
  if (result.workerExit !== undefined || (failedState && tests.length === 0)) status = 'crashed'
  else if (failedState || charged.length > 0) status = 'failed'
  else if (result.state === 'skip') status = 'skipped'
  else status = 'passed'
  const fileError =
    status === 'crashed' || status === 'failed' ? normalizeErrors(errors) : undefined
  return {
    file: info.path,
    status,
    ...(fileError === undefined ? {} : { fileError }),
    tests,
    durationMs: result.durationMs,
  }
}

/**
 * Builds the run: files sorted by path (they finish in any order), tests in collection order.
 * `snapshots`, `console` and `trace` are left out; they are T12.16's. `success` is false when a
 * file failed or crashed, a run error was reported, or the run was interrupted.
 */
export function buildNormalizedRun(parts: RunParts): NormalizedRun {
  const files: NormalizedFile[] = []
  for (const record of parts.files.values()) {
    if (record.ended !== undefined) {
      files.push(normalizeFile(record.ended.file, record, record.ended))
    }
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const runErrors = parts.runErrors.map(normalizeError)
  const clean = files.every((file) => file.status !== 'failed' && file.status !== 'crashed')
  return {
    schemaVersion: 1,
    runner: parts.runner,
    runnerVersion: parts.runnerVersion,
    suite: parts.suite,
    startedAt: parts.startedAt,
    env: parts.env,
    files,
    runErrors,
    success: clean && runErrors.length === 0 && parts.reason !== 'interrupted',
  }
}
