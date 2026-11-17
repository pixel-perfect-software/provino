// The collected trees of a run, kept only when `--tree` asks for them (performance rule 4). The
// store is never built without the flag (`reporter.test.ts` probes it).
//
// A running file's record is its collected tasks (the event's own array, not copied) and, for each
// test that ends, three numbers pushed on parallel arrays, so a handler is constant work. The
// record is turned into a `TreeFile` by `compact`, which the reporter calls where it builds the
// file's own line (a frame, or `run:end`), never in a handler:
//
// - a file that fully passed keeps its numbers only: its folded line is built from them, and its
//   tasks and results are released;
// - any other file keeps its suites with their counts and times, and only its failed tests (at most
//   `MAX_LISTED_FAILURES`, the rest counted), each with the first line of its error. Passing,
//   skipped and todo tests are counted into their suite's `rest`, which the view prints as one row.

import type { FileResult, SerializedError, TaskId, TaskNode, TestTask } from '@provino/types'
import type { FolderFile } from '../../internal/views/folders.ts'
import { fileOutcome } from './file-outcome.ts'
import type { FinishedFile } from './state.ts'

/** How a suite or test ended, as the tree draws it. */
export type NodeState = 'pass' | 'fail' | 'skip' | 'todo'

/** The failed tests listed under one file; the rest are counted (`OpenFile.moreFailed`). */
export const MAX_LISTED_FAILURES = 50
/** The file's own errors printed under its row. */
const MAX_FILE_MESSAGES = 3
/** The longest first line kept of an error, in characters. */
const MAX_MESSAGE = 300

/**
 * The tests of a suite that are not listed under it: the ones that passed, were skipped or are
 * todo. `skipped` counts the skipped ones only; `todo` the todo ones.
 * @internal
 */
export interface TreeRest {
  readonly passed: number
  readonly skipped: number
  readonly todo: number
  readonly durationMs: number
}

/**
 * A suite, or a failed test, of a file that did not fully pass.
 * @internal
 */
export interface TreeNode {
  readonly kind: 'suite' | 'test'
  readonly name: string
  readonly state: NodeState
  /** Tests that ended in it (a test: 1). */
  readonly tests: number
  readonly failed: number
  /** Skipped and todo tests. */
  readonly skipped: number
  /** The sum of the times of its tests. */
  readonly durationMs: number
  /** The first line of the first error: a failed test's, or a suite whose own hook threw. */
  readonly message: string | undefined
  /** An open suite's suites and failed tests, in declaration order. Empty for a folded suite. */
  readonly children: readonly TreeNode[]
  readonly rest: TreeRest | undefined
}

/**
 * What a file that did not fully pass shows under its row.
 * @internal
 */
export interface OpenFile {
  readonly children: readonly TreeNode[]
  readonly rest: TreeRest | undefined
  /** The first lines of the file's own errors (a collection error, a worker that died). */
  readonly messages: readonly string[]
  /** Failed tests beyond `MAX_LISTED_FAILURES`. */
  readonly moreFailed: number
}

/**
 * A finished file as the tree draws it.
 * @internal
 */
export interface TreeFile extends FolderFile {
  /** `undefined` for a file that fully passed: its folded row says it all. */
  readonly open: OpenFile | undefined
}

/**
 * The trees of the files a run shows.
 * @internal
 */
export interface TreeStore {
  /** `file:collected`: the file's tasks. */
  collected(fileId: TaskId, tasks: readonly TaskNode[]): void
  /** A test ended. A file with no record (never collected, or already compacted) is ignored. */
  testEnd(
    fileId: TaskId,
    testId: TaskId,
    state: 'pass' | 'fail' | 'skip' | 'todo' | 'queued' | 'running',
    durationMs: number,
    error?: SerializedError,
  ): void
  /** A suite ended `fail` with errors of its own (an `afterAll` that threw). */
  suiteFailed(fileId: TaskId, suiteId: TaskId, error: SerializedError | undefined): void
  /** The file's tree: built once, and its record released. */
  compact(finished: FinishedFile): TreeFile
  /** Files whose record is still held. */
  held(): number
  /** Releases every record. */
  clear(): void
}

const PASS = 0
const FAIL = 1
const SKIP = 2
const TODO = 3

const NO_NODES: readonly TreeNode[] = []

/** A file's record while it runs. */
interface Running {
  readonly tasks: readonly TaskNode[]
  readonly ids: TaskId[]
  readonly codes: number[]
  readonly times: number[]
  errors: Map<TaskId, SerializedError> | undefined
  suiteErrors: Map<TaskId, SerializedError | undefined> | undefined
}

/** `Name: first line of the message`; the name is left out when it is `Error` or the line has it. */
function firstLine(error: SerializedError | undefined): string | undefined {
  if (error === undefined) return undefined
  const { name, message } = error
  const end = message.indexOf('\n')
  const line = (end === -1 ? message : message.slice(0, end)).slice(0, MAX_MESSAGE)
  if (line === '') return name
  return name === 'Error' || line.startsWith(name) ? line : `${name}: ${line}`
}

/** What `level` is working on, shared down the walk. */
interface Walk {
  readonly byId: ReadonlyMap<TaskId, TaskNode>
  /** Each ended test's place in the record's arrays. */
  readonly at: ReadonlyMap<TaskId, number>
  readonly record: Running
  /** Failed tests that may still be listed. */
  left: number
  /** Failed tests past the budget. */
  more: number
}

/** The tally of one level: a file's or a suite's own children, and everything below them. */
interface Level {
  readonly children: TreeNode[]
  tests: number
  failed: number
  skipped: number
  durationMs: number
  /** The tests of this level that are not listed. */
  passed: number
  skippedOnly: number
  todo: number
  restMs: number
}

function level(ids: readonly TaskId[], walk: Walk): Level {
  const out: Level = {
    children: [],
    tests: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    passed: 0,
    skippedOnly: 0,
    todo: 0,
    restMs: 0,
  }
  for (const id of ids) {
    const task = walk.byId.get(id)
    if (task === undefined) continue
    if (task.type === 'suite') {
      const node = suiteNode(task.id, task.name, task.children, walk)
      out.children.push(node)
      out.tests += node.tests
      out.failed += node.failed
      out.skipped += node.skipped
      out.durationMs += node.durationMs
    } else if (task.type === 'test') {
      const index = walk.at.get(task.id)
      if (index === undefined) continue // never ended: counted nowhere, as everywhere else
      const ms = walk.record.times[index] as number
      out.tests++
      out.durationMs += ms
      switch (walk.record.codes[index]) {
        case FAIL:
          out.failed++
          if (walk.left > 0) {
            walk.left--
            out.children.push(failedTest(task, ms, walk.record.errors?.get(task.id)))
          } else walk.more++
          break
        case SKIP:
          out.skipped++
          out.skippedOnly++
          out.restMs += ms
          break
        case TODO:
          out.skipped++
          out.todo++
          out.restMs += ms
          break
        default:
          out.passed++
          out.restMs += ms
      }
    }
  }
  return out
}

function failedTest(
  task: TestTask,
  durationMs: number,
  error: SerializedError | undefined,
): TreeNode {
  return {
    kind: 'test',
    name: task.name,
    state: 'fail',
    tests: 1,
    failed: 1,
    skipped: 0,
    durationMs,
    message: firstLine(error),
    children: NO_NODES,
    rest: undefined,
  }
}

function restOf(tally: Level): TreeRest | undefined {
  if (tally.passed === 0 && tally.skippedOnly === 0 && tally.todo === 0) return undefined
  return {
    passed: tally.passed,
    skipped: tally.skippedOnly,
    todo: tally.todo,
    durationMs: tally.restMs,
  }
}

function suiteNode(id: TaskId, name: string, childIds: readonly TaskId[], walk: Walk): TreeNode {
  const tally = level(childIds, walk)
  const hasOwnError = walk.record.suiteErrors?.has(id) === true
  const failed = tally.failed > 0 || hasOwnError
  const state: NodeState = failed
    ? 'fail'
    : tally.tests > 0 && tally.skipped === tally.tests
      ? tally.todo === tally.tests
        ? 'todo'
        : 'skip'
      : 'pass'
  return {
    kind: 'suite',
    name,
    state,
    tests: tally.tests,
    failed: tally.failed,
    skipped: tally.skipped,
    durationMs: tally.durationMs,
    message: hasOwnError ? firstLine(walk.record.suiteErrors?.get(id)) : undefined,
    // A suite that holds no failure is one folded row: what is below it is not kept.
    children: failed ? tally.children : NO_NODES,
    rest: failed ? restOf(tally) : undefined,
  }
}

function openFile(record: Running, result: FileResult): OpenFile {
  const byId = new Map<TaskId, TaskNode>()
  let root: TaskNode | undefined
  for (const task of record.tasks) {
    byId.set(task.id, task)
    if (task.type === 'file') root = task
  }
  const at = new Map<TaskId, number>()
  record.ids.forEach((id, index) => {
    at.set(id, index)
  })
  const walk: Walk = { byId, at, record, left: MAX_LISTED_FAILURES, more: 0 }
  const tally = root === undefined || root.type !== 'file' ? undefined : level(root.children, walk)
  return {
    children: tally?.children ?? NO_NODES,
    rest: tally === undefined ? undefined : restOf(tally),
    messages: fileMessages(result),
    moreFailed: walk.more,
  }
}

function fileMessages(result: FileResult): readonly string[] {
  const lines: string[] = []
  for (const error of result.errors.slice(0, MAX_FILE_MESSAGES)) {
    const line = firstLine(error)
    if (line !== undefined) lines.push(line)
  }
  return lines
}

/**
 * Creates an empty store.
 * @internal
 */
export function createTreeStore(): TreeStore {
  const records = new Map<TaskId, Running>()
  return {
    collected(fileId, tasks) {
      records.set(fileId, {
        tasks,
        ids: [],
        codes: [],
        times: [],
        errors: undefined,
        suiteErrors: undefined,
      })
    },
    testEnd(fileId, testId, state, durationMs, error) {
      const record = records.get(fileId)
      if (record === undefined) return
      let code: number
      switch (state) {
        case 'pass':
          code = PASS
          break
        case 'fail':
          code = FAIL
          break
        case 'skip':
          code = SKIP
          break
        case 'todo':
          code = TODO
          break
        default:
          return
      }
      record.ids.push(testId)
      record.codes.push(code)
      record.times.push(durationMs)
      if (code === FAIL && error !== undefined) {
        record.errors ??= new Map()
        record.errors.set(testId, error)
      }
    },
    suiteFailed(fileId, suiteId, error) {
      const record = records.get(fileId)
      if (record === undefined) return
      record.suiteErrors ??= new Map()
      record.suiteErrors.set(suiteId, error)
    },
    compact(finished) {
      const base = fileOutcome(finished)
      const { result } = finished
      const id = result.file.fileId
      const record = records.get(id)
      records.delete(id)
      if (finished.failed === 0 && result.state !== 'fail' && result.errors.length === 0) {
        return { ...base, open: undefined }
      }
      const open =
        record === undefined
          ? { children: NO_NODES, rest: undefined, messages: fileMessages(result), moreFailed: 0 }
          : openFile(record, result)
      return { ...base, open }
    },
    held: () => records.size,
    clear: () => records.clear(),
  }
}
