// The collected trees of a run, kept only when `--tree` asks for them (performance rule 4). The
// store is never built without the flag (`reporter.test.ts` probes it).
//
// A running file's record is its collected tasks (the event's own array, not copied) and, for each
// test that ends, three values pushed on parallel arrays, so a handler is constant work. The
// record is turned into a `TreeFile` by `compact`, which the reporter calls as the file ends, so
// the views never depend on the live ring admitting the file and a record never outlives its file
// (the held records are the running files'). A file that fully passed costs a map delete; a file
// with a failure costs a walk of its own tasks, once:
//
// - a file that fully passed keeps its numbers only: its folded line is built from them, and its
//   tasks and results are released;
// - any other file keeps its suites with their counts and times, and only its failed tests, each
//   with the first line of its error. Everything kept is bounded: at most `MAX_TREE_FAILURES`
//   failed tests per file (the rest counted, and only that many errors held while the file runs),
//   at most `MAX_TREE_SUITES` listed suites per level (the rest counted). Passing, skipped and todo
//   tests are counted into their suite's `rest`, which the view prints as one row.
// - A suite whose own hook threw is a failure for every suite above it, so the tree opens down to it.

import type { FileResult, SerializedError, TaskId, TaskNode, TestTask } from '@provino/types'
import { type FileKind, type FolderFile, outcomeOf } from '../../internal/views/folders.ts'
import { header } from '../../text/format.ts'
import { copyFlat } from './bound.ts'
import { fileOutcome } from './file-outcome.ts'
import type { FinishedFile } from './state.ts'

/** The failed tests listed under one file, and the errors held for them; the rest are counted (`OpenFile.moreFailed`). */
export const MAX_TREE_FAILURES = 50
/** The suites listed under one suite or file; the rest are counted (`moreSuites`). */
export const MAX_TREE_SUITES = 50
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
  readonly state: FileKind
  /** Tests that ended in it, below it too (a test: 1). */
  readonly tests: number
  readonly failed: number
  /** Skipped and todo tests. */
  readonly skipped: number
  /** Of those, the todo ones. */
  readonly todo: number
  /** The sum of the times of its tests. */
  readonly durationMs: number
  /** The first line of the first error: a failed test's, or a suite whose own hook threw. */
  readonly message: string | undefined
  /** An open suite's suites and failed tests, in declaration order. Empty for a folded suite. */
  readonly children: readonly TreeNode[]
  readonly rest: TreeRest | undefined
  /** Suites of an open suite past `MAX_TREE_SUITES`, counted and not listed. */
  readonly moreSuites: number
}

/**
 * What a file that did not fully pass shows under its row.
 * @internal
 */
export interface OpenFile {
  readonly children: readonly TreeNode[]
  readonly rest: TreeRest | undefined
  /** Suites of the file past `MAX_TREE_SUITES`, counted and not listed. */
  readonly moreSuites: number
  /** The first lines of the file's own errors (a collection error, a worker that died). */
  readonly messages: readonly string[]
  /** Failed tests beyond `MAX_TREE_FAILURES`. */
  readonly moreFailed: number
}

/**
 * A finished file as the tree draws it.
 * @internal
 */
export interface TreeFile extends FolderFile {
  /** Absent for a file that fully passed: its folded row says it all. */
  readonly open?: OpenFile
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

const NO_NODES: readonly TreeNode[] = []

/** A file's record while it runs. */
interface Running {
  readonly tasks: readonly TaskNode[]
  readonly ids: TaskId[]
  readonly states: FileKind[]
  readonly times: number[]
  /** The first failed tests' errors, at most `MAX_TREE_FAILURES`. */
  errors: Map<TaskId, SerializedError> | undefined
  /** The suites that failed with an error of their own: the first `MAX_TREE_SUITES` keep it. */
  suiteErrors: Map<TaskId, SerializedError | undefined> | undefined
}

/**
 * The first line of an error as a log shows it (`TypeError: message`: `header`'s rule), copied
 * flat so the whole message it was cut from is not kept alive with it.
 */
function firstLine(error: SerializedError | undefined): string | undefined {
  if (error === undefined) return undefined
  const end = error.message.indexOf('\n')
  const line = end === -1 ? error.message : error.message.slice(0, end)
  return copyFlat(header({ name: error.name, message: line.slice(0, MAX_MESSAGE) }))
}

/** What `level` is working on, shared down the walk. */
interface Walk {
  readonly byId: ReadonlyMap<TaskId, TaskNode>
  /** Each ended test's place in the record's arrays. */
  readonly at: ReadonlyMap<TaskId, number>
  readonly record: Running
  /** Failed tests that may still be listed. */
  left: number
  /** Failed tests not listed: past the budget, or inside a suite that is not listed. */
  more: number
}

/** The tally of one level: a file's or a suite's own children, and everything below them. */
interface Level {
  readonly children: TreeNode[]
  /** Suites past `MAX_TREE_SUITES`: in the totals, not in `children`. */
  moreSuites: number
  // Everything at this level and below it.
  tests: number
  failed: number
  /** Suites below this level that failed (their own hook threw, or a failure is below them). */
  failedSuites: number
  skipped: number
  todo: number
  durationMs: number
  // The tests of this level itself that are not listed.
  ownPassed: number
  ownSkipped: number
  ownTodo: number
  ownMs: number
}

/** `listing` is false inside a suite that is not listed: its tests are counted and none is kept. */
function level(ids: readonly TaskId[], walk: Walk, listing: boolean): Level {
  const out: Level = {
    children: [],
    moreSuites: 0,
    tests: 0,
    failed: 0,
    failedSuites: 0,
    skipped: 0,
    todo: 0,
    durationMs: 0,
    ownPassed: 0,
    ownSkipped: 0,
    ownTodo: 0,
    ownMs: 0,
  }
  let suitesListed = 0
  for (const id of ids) {
    const task = walk.byId.get(id)
    if (task === undefined) continue
    if (task.type === 'suite') {
      const listed = listing && suitesListed < MAX_TREE_SUITES
      const node = suiteNode(task.id, task.name, task.children, walk, listed)
      if (listed) {
        out.children.push(node)
        suitesListed++
      } else out.moreSuites++
      // A failed suite is a failure for every level above it, whether or not a test of it failed:
      // the tree opens down to it.
      if (node.state === 'fail') out.failedSuites++
      out.tests += node.tests
      out.failed += node.failed
      out.skipped += node.skipped
      out.todo += node.todo
      out.durationMs += node.durationMs
    } else if (task.type === 'test') {
      const index = walk.at.get(task.id)
      if (index === undefined) continue // never ended: counted nowhere, as everywhere else
      const ms = walk.record.times[index] as number
      out.tests++
      out.durationMs += ms
      switch (walk.record.states[index]) {
        case 'fail':
          out.failed++
          if (listing && walk.left > 0) {
            walk.left--
            out.children.push(failedTest(task, ms, walk.record.errors?.get(task.id)))
          } else walk.more++
          break
        case 'skip':
          out.skipped++
          out.ownSkipped++
          out.ownMs += ms
          break
        case 'todo':
          out.skipped++
          out.todo++
          out.ownTodo++
          out.ownMs += ms
          break
        default:
          out.ownPassed++
          out.ownMs += ms
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
    todo: 0,
    durationMs,
    message: firstLine(error),
    children: NO_NODES,
    rest: undefined,
    moreSuites: 0,
  }
}

function restOf(tally: Level): TreeRest | undefined {
  if (tally.ownPassed === 0 && tally.ownSkipped === 0 && tally.ownTodo === 0) return undefined
  return {
    passed: tally.ownPassed,
    skipped: tally.ownSkipped,
    todo: tally.ownTodo,
    durationMs: tally.ownMs,
  }
}

function suiteNode(
  id: TaskId,
  name: string,
  childIds: readonly TaskId[],
  walk: Walk,
  listing: boolean,
): TreeNode {
  const tally = level(childIds, walk, listing)
  const hasOwnError = walk.record.suiteErrors?.has(id) === true
  const failures = tally.failed + tally.failedSuites + (hasOwnError ? 1 : 0)
  // The one rule for a file's kind, over everything below the suite, so a suite that holds only a
  // nested todo suite is todo, as a file of the same is.
  const state = outcomeOf(tally.tests, failures, tally.skipped, tally.todo)
  const open = state === 'fail'
  return {
    kind: 'suite',
    name,
    state,
    tests: tally.tests,
    failed: tally.failed,
    skipped: tally.skipped,
    todo: tally.todo,
    durationMs: tally.durationMs,
    message: listing && hasOwnError ? firstLine(walk.record.suiteErrors?.get(id)) : undefined,
    // A suite that holds no failure is one folded row: what is below it is not kept.
    children: open ? tally.children : NO_NODES,
    rest: open ? restOf(tally) : undefined,
    moreSuites: open ? tally.moreSuites : 0,
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
  const walk: Walk = { byId, at, record, left: MAX_TREE_FAILURES, more: 0 }
  const tally =
    root === undefined || root.type !== 'file' ? undefined : level(root.children, walk, true)
  return {
    children: tally?.children ?? NO_NODES,
    rest: tally === undefined ? undefined : restOf(tally),
    moreSuites: tally?.moreSuites ?? 0,
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
        states: [],
        times: [],
        errors: undefined,
        suiteErrors: undefined,
      })
    },
    testEnd(fileId, testId, state, durationMs, error) {
      const record = records.get(fileId)
      if (record === undefined || state === 'queued' || state === 'running') return
      record.ids.push(testId)
      record.states.push(state)
      record.times.push(durationMs)
      // Only as many errors as the file will list: a file with 5,000 failures holds 50 stacks.
      if (
        state === 'fail' &&
        error !== undefined &&
        (record.errors?.size ?? 0) < MAX_TREE_FAILURES
      ) {
        record.errors ??= new Map()
        record.errors.set(testId, error)
      }
    },
    suiteFailed(fileId, suiteId, error) {
      const record = records.get(fileId)
      if (record === undefined) return
      record.suiteErrors ??= new Map()
      // The suite is marked failed whatever its error: past the listing cap only the mark is kept.
      record.suiteErrors.set(suiteId, record.suiteErrors.size < MAX_TREE_SUITES ? error : undefined)
    },
    compact(finished) {
      const base = fileOutcome(finished)
      const { result } = finished
      const id = result.file.fileId
      const record = records.get(id)
      records.delete(id)
      // Fully passed: no failed test, no failed suite (whatever the file's own state says of it:
      // an error a suite's hook threw must stay visible), no error of the file's own.
      const suiteFailed = record?.suiteErrors !== undefined
      if (
        finished.failed === 0 &&
        !suiteFailed &&
        result.state !== 'fail' &&
        result.errors.length === 0
      ) {
        return base
      }
      const open: OpenFile =
        record === undefined
          ? {
              children: NO_NODES,
              rest: undefined,
              moreSuites: 0,
              messages: fileMessages(result),
              moreFailed: 0,
            }
          : openFile(record, result)
      return { ...base, open }
    },
    held: () => records.size,
    clear: () => records.clear(),
  }
}
