// What the reporters that write one document at `run:end` (`json`, `junit`, `github-actions`)
// need of a run: each file's tests in collection order, how each ended, its console writes and the
// errors that belong to it, kept as the events come. One collector, so they agree on what a run
// held.
import type { Reporter, TaskId } from '@provino/types'
import {
  type FileRecord,
  newFileRecord,
  type RunError,
  testsInOrder,
} from '../normalized-json/build.ts'

/** What a run has produced so far. `run:start` replaces every field. */
export interface RunRecord {
  /** The project root `run:start` named: paths in the run are relative to it. */
  root: string
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

/**
 * A run record and the handlers that fill it. The record is one object that `run:start` resets in
 * place, so a reporter reads `record.files` whenever it needs it.
 */
export function createCollector(cwd: string = process.cwd()): {
  readonly record: RunRecord
  readonly handlers: CollectHandlers
} {
  const record: RunRecord = { root: cwd, files: new Map(), runErrors: [] }

  function fileRecord(fileId: TaskId): FileRecord {
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
      record.files = new Map()
      record.runErrors = []
    },

    'file:collected'(file, event) {
      const entry = fileRecord(file.fileId)
      for (const test of testsInOrder(event.tasks)) entry.tests.set(test.id, test)
    },

    'test:attempt-end'(task, event) {
      // Every attempt is noted, so a test with no retries reads 0, not "unknown".
      const entry = fileRecord(task.fileId)
      entry.retries.set(task.id, (entry.retries.get(task.id) ?? 0) + (event.willRetry ? 1 : 0))
    },

    'task:end'(task, event) {
      if (task.type === 'suite' && event.type === 'suite-end') {
        // A suite's own failure (an `afterAll`) is in no test and no file result.
        const { state, errors } = event.result
        if (state === 'fail') fileRecord(task.fileId).suiteErrors.push(...errors)
        return
      }
      if (task.type !== 'test' || event.type !== 'test-end') return
      const entry = fileRecord(task.fileId)
      if (!entry.tests.has(task.id)) entry.tests.set(task.id, task)
      entry.results.set(task.id, event.result)
    },

    console(file, event) {
      fileRecord(file.fileId).console.push(event)
    },

    unhandled(file, event) {
      if (file === null) {
        record.runErrors.push({ error: event.error, unhandled: true })
        return
      }
      const entry = fileRecord(file.fileId)
      // An error charged to one of the file's tests is that test's failure.
      if (event.ownerId !== null && entry.tests.has(event.ownerId)) {
        entry.late.set(event.ownerId, [...(entry.late.get(event.ownerId) ?? []), event.error])
      } else {
        entry.unhandled.push(event.error)
      }
    },

    'file:end'(result) {
      fileRecord(result.file.fileId).ended = result
    },

    error(error) {
      record.runErrors.push({ error, unhandled: false })
    },
  }
  return { record, handlers }
}
