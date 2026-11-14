// What the reporters that read a whole file's events at once (`default` and its modes, `json`,
// `junit`, `github-actions`) need of a run: each file's tests in collection order, how each ended,
// its console writes and the errors that belong to it, kept as the events come. One collector, so
// they agree on what a run held, and one `outcomeOf`, so they agree on which tests failed.
import type {
  FileResult,
  Reporter,
  RuntimeEventOf,
  SerializedError,
  SuiteTask,
  TaskId,
  TaskNode,
  TaskResult,
  TestTask,
} from '@provino/types'

/** What the reporters have seen of one file. */
export interface FileRecord {
  /** The file's tests in collection order; a test that ended without being collected is added. */
  readonly tests: Map<TaskId, TestTask>
  /** The `test-end` result of each test that ended, in the order they ended. */
  readonly results: Map<TaskId, TaskResult>
  /** The collected tree (`file:collected`): the verbose list and a failed suite's name path read it. */
  tasks: readonly TaskNode[]
  /** Unhandled errors the runtime tied to this file. */
  readonly unhandled: SerializedError[]
  /** Errors the runtime charged to a test after it ended (`errors.lateErrors: 'fail-owner'`). */
  readonly late: Map<TaskId, SerializedError[]>
  /** Suites that ended `fail` with errors of their own (an `afterAll` that threw): in no file result. */
  readonly failedSuites: { readonly task: SuiteTask; readonly errors: readonly SerializedError[] }[]
  /**
   * The order each suite's children ran in, for a suite a randomized run shuffled (the end event's
   * `childOrder`); the file's own, from `file:end`, is under the file node's id.
   */
  readonly orders: Map<TaskId, readonly TaskId[]>
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

export function newFileRecord(): FileRecord {
  return {
    tests: new Map(),
    results: new Map(),
    tasks: [],
    unhandled: [],
    late: new Map(),
    failedSuites: [],
    orders: new Map(),
    retries: new Map(),
    console: [],
    ended: undefined,
  }
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

/** How a test ended, once an error charged to it afterwards is counted. */
export interface Outcome {
  /**
   * What the test's `test-end` said, with `state` `fail` and the late errors added when one was
   * charged to it afterwards (whatever it ended as); `undefined` for a test that never ended.
   */
  readonly result: TaskResult | undefined
  /** Errors charged to the test after it ended. */
  readonly late: readonly SerializedError[]
  /**
   * It ended `fail`, or an error was charged to it afterwards while it passed or never ended
   * (Jest's `errors.lateErrors: 'fail-owner'`, T5.11). A skipped or todo test ran nothing to fail:
   * an error charged to it leaves it as it was.
   */
  readonly failed: boolean
  /** The test's own errors, then the late ones. */
  readonly errors: readonly SerializedError[]
}

const NONE: readonly SerializedError[] = []

/**
 * The one rule for a test's outcome: an error the runtime charged to it after it ended is its
 * failure (and its file's), so a test that passed or never ended is `failed`, with the error
 * appended to its own. A test that ended `fail` stays so; one that was skipped or is todo is left
 * alone.
 */
export function outcomeOf(entry: FileRecord, test: TestTask): Outcome {
  const result = entry.results.get(test.id)
  const late = entry.late.get(test.id) ?? NONE
  if (late.length === 0) {
    return { result, late, failed: result?.state === 'fail', errors: result?.errors ?? NONE }
  }
  const errors = [...(result?.errors ?? NONE), ...late]
  if (result !== undefined && result.state !== 'pass' && result.state !== 'fail') {
    return { result, late, failed: false, errors }
  }
  return {
    result: result === undefined ? undefined : { ...result, state: 'fail', errors },
    late,
    failed: true,
    errors,
  }
}

/** The errors of the file's failed suites, in the order the suites ended. */
export function suiteErrorsOf(entry: FileRecord): SerializedError[] {
  return entry.failedSuites.flatMap((suite) => suite.errors)
}

/** A file's console writes, by where they came from. */
export interface GroupedConsole {
  /** Writes of a suite's or the file's `beforeAll`/`afterAll`, the top level, or outside any task. */
  readonly file: RuntimeEventOf<'console'>[]
  /** Writes of each test, its each-hooks included. */
  readonly tests: Map<TaskId, RuntimeEventOf<'console'>[]>
}

/** The file's console writes routed to the test they ran in, or to the file, in the order they came. */
export function groupConsole(entry: FileRecord): GroupedConsole {
  const file: RuntimeEventOf<'console'>[] = []
  const tests = new Map<TaskId, RuntimeEventOf<'console'>[]>()
  for (const write of entry.console) {
    const test = write.taskId === null ? undefined : entry.tests.get(write.taskId)
    if (test === undefined) {
      file.push(write)
      continue
    }
    const existing = tests.get(test.id)
    if (existing === undefined) tests.set(test.id, [write])
    else existing.push(write)
  }
  return { file, tests }
}

/** What a run has produced so far. `run:start` replaces every field. */
export interface RunRecord {
  /** The project root `run:start` named: paths in the run are relative to it. */
  root: string
  /** The wall clock at `run:start`, as an ISO string (read once, when `run:start` never came). */
  readonly startedAt: string
  files: Map<TaskId, FileRecord>
  /** Unhandled errors tied to no file, and every `error` event. */
  runErrors: RunError[]
}

/** The handlers that fill a `RunRecord`; a reporter spreads them and adds its own. */
export type CollectHandlers = Required<
  Pick<
    Reporter,
    | 'run:start'
    | 'file:collected'
    | 'test:attempt-end'
    | 'task:end'
    | 'console'
    | 'unhandled'
    | 'file:end'
    | 'error'
  >
>

/** What `createCollector` takes. */
export interface CollectorOptions {
  /** Where paths are relative to until `run:start` names the root. Default `process.cwd()`. */
  readonly cwd?: string
  /** The wall clock, in epoch milliseconds, for `startedAt`. Default `Date.now`. */
  readonly now?: () => number
  /** Keep the files' console writes. Default `true`; a reporter that prints none turns it off. */
  readonly console?: boolean
}

/** A run record, the handlers that fill it, and the way to let a file's record go. */
export interface Collector {
  readonly record: RunRecord
  readonly handlers: CollectHandlers
  /**
   * Frees a file's record, for a reporter that is done with it at `file:end`. An event for the file
   * after that (a late console write, an unhandled error) makes no new record and is dropped:
   * `isReleased` tells a reporter that wants the last.
   */
  release(fileId: TaskId): void
  isReleased(fileId: TaskId): boolean
}

/**
 * A run record and the handlers that fill it. The record is one object that `run:start` resets in
 * place, so a reporter reads `record.files` whenever it needs it.
 */
export function createCollector(options: CollectorOptions = {}): Collector {
  const now = options.now ?? Date.now
  const keepConsole = options.console !== false
  /** Stamped by `run:start`; a run that never started reads the clock the first time it is asked. */
  let startedAt: string | undefined
  const record: RunRecord = {
    root: options.cwd ?? process.cwd(),
    get startedAt() {
      startedAt ??= new Date(now()).toISOString()
      return startedAt
    },
    files: new Map(),
    runErrors: [],
  }
  const released = new Set<TaskId>()

  /** The file's record, made on first touch; `undefined` for a file that was released. */
  function fileRecord(fileId: TaskId): FileRecord | undefined {
    if (released.has(fileId)) return undefined
    let existing = record.files.get(fileId)
    if (existing === undefined) {
      existing = newFileRecord()
      record.files.set(fileId, existing)
    }
    return existing
  }

  const handlers: CollectHandlers = {
    'run:start'(info) {
      record.root = info.root
      startedAt = new Date(now()).toISOString()
      record.files = new Map()
      record.runErrors = []
      released.clear()
    },

    'file:collected'(file, event) {
      const entry = fileRecord(file.fileId)
      if (entry === undefined) return
      entry.tasks = event.tasks
      for (const test of testsInOrder(event.tasks)) entry.tests.set(test.id, test)
    },

    'test:attempt-end'(task, event) {
      // Every attempt is noted, so a test with no retries reads 0, not "unknown".
      const entry = fileRecord(task.fileId)
      if (entry === undefined) return
      entry.retries.set(task.id, (entry.retries.get(task.id) ?? 0) + (event.willRetry ? 1 : 0))
    },

    'task:end'(task, event) {
      const entry = fileRecord(task.fileId)
      if (entry === undefined) return
      if (task.type === 'suite' && event.type === 'suite-end') {
        // A suite's own failure (an `afterAll`) is in no test and no file result.
        const { state, errors } = event.result
        if (event.result.childOrder !== undefined)
          entry.orders.set(task.id, event.result.childOrder)
        if (state === 'fail' && errors.length > 0) entry.failedSuites.push({ task, errors })
        return
      }
      if (task.type !== 'test' || event.type !== 'test-end') return
      if (!entry.tests.has(task.id)) entry.tests.set(task.id, task)
      entry.results.set(task.id, event.result)
    },

    console(file, event) {
      if (!keepConsole) return
      fileRecord(file.fileId)?.console.push(event)
    },

    unhandled(file, event) {
      if (file === null) {
        record.runErrors.push({ error: event.error, unhandled: true })
        return
      }
      const entry = fileRecord(file.fileId)
      if (entry === undefined) return
      // An error charged to one of the file's tests is that test's failure.
      const owned = event.ownerId !== null && entry.tests.has(event.ownerId)
      if (owned) {
        const late = entry.late.get(event.ownerId)
        if (late === undefined) entry.late.set(event.ownerId, [event.error])
        else late.push(event.error)
      } else {
        entry.unhandled.push(event.error)
      }
    },

    'file:end'(result) {
      const entry = fileRecord(result.file.fileId)
      if (entry === undefined) return
      entry.ended = result
      const root = entry.tasks.find((task) => task.type === 'file')
      if (root !== undefined && result.childOrder !== undefined) {
        entry.orders.set(root.id, result.childOrder)
      }
    },

    error(error) {
      record.runErrors.push({ error, unhandled: false })
    },
  }

  return {
    record,
    handlers,
    release(fileId) {
      record.files.delete(fileId)
      released.add(fileId)
    },
    isReleased: (fileId) => released.has(fileId),
  }
}
