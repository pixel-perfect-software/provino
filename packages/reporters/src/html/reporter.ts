import { basename, resolve } from 'node:path'
import type { FileResult, Reporter, TaskId, WorkerExit } from '@provino/types'
import { createCollector, outcomeOf, suiteErrorsOf } from '../internal/collect.ts'
import { fileKind } from '../internal/views/folders.ts'
import { writeAtomically } from '../internal/write-file.ts'
import {
  createStringTable,
  type FailureRow,
  type FileErrorRow,
  type FileRow,
  type FileStatus,
  failureText,
  MAX_FAILURES,
  type ReportData,
  roundMs,
  type TestRow,
  type TestStatus,
} from './data.ts'
import { renderDocument } from './render.ts'

/**
 * Options for `htmlReporter`.
 * @beta
 */
export interface HtmlReporterOptions {
  /** Where the page is written, atomically; its directory is created. The page is never written to a stream. */
  readonly outputFile: string
  /**
   * The project root that stack frames in failure text are shown relative to, until `run:start`
   * names the run's. Default: `process.cwd()`.
   */
  readonly root?: string
  /**
   * A monotonic clock in milliseconds, read when a file starts and when it ends, for the timeline
   * (D139). Default: `performance.now`.
   */
  readonly now?: () => number
  /** The wall clock in epoch milliseconds, for the run's start time. Default: `Date.now`. */
  readonly wallClock?: () => number
}

/** How a worker's end reads in a crashed file's text when the file's own errors say nothing. */
function describeExit(exit: WorkerExit): string {
  switch (exit.type) {
    case 'signal':
      return `was killed by ${exit.signal}${exit.likelyOom ? ' (likely out of memory)' : ''}`
    case 'exit':
      return `exited with code ${exit.code}`
    case 'oom':
      return `ran out of memory (limit ${exit.limitMb} MB)`
    case 'timeout':
      return `timed out (${exit.phase}, after ${exit.limitMs} ms)`
  }
}

/**
 * The HTML reporter: one self-contained page at `run:end`, written to `outputFile`, with a summary,
 * a searchable test tree, a status map, time by folder and a per-worker timeline. It makes no
 * network request and loads no resource (the page's Content-Security-Policy forbids both).
 *
 * - A file is one row when it ends: a handler only appends compact rows over one string table, so
 *   what it keeps is the run's tests and the text of its failures (at most 16 KB each, and only
 *   the first 1,000), never the files' trees.
 * - The timeline is stamped by the reporter itself: `now()` at `file:start` and `file:end`, with
 *   the worker's id. A replaced worker has a new id, so it and the gap show.
 * - Nothing it reads changes what the other reporters see, and nothing is written before `run:end`.
 * @beta
 */
export function htmlReporter(options: HtmlReporterOptions): Reporter {
  const now = options.now ?? ((): number => performance.now())
  const { record, handlers, release, isReleased } = createCollector({
    ...(options.root === undefined ? {} : { cwd: options.root }),
    ...(options.wallClock === undefined ? {} : { now: options.wallClock }),
    console: false,
  })
  let table = createStringTable()
  let files: FileRow[] = []
  let tests: TestRow[] = []
  let failures: FailureRow[] = []
  let fileErrors: FileErrorRow[] = []
  let omitted = 0
  let workers = 0
  let origin = 0
  /** Files that started and have not ended: where and when. */
  let running = new Map<TaskId, { readonly startMs: number; readonly workerId: number }>()
  let compacted = new Set<TaskId>()

  /** The file as rows, once: its tests, its own error text and its place on the timeline. `endMs` is -1 when no `file:end` told it. */
  function compact(result: FileResult, endMs: number): void {
    const { file } = result
    if (compacted.has(file.fileId)) return
    compacted.add(file.fileId)
    const entry = record.files.get(file.fileId)
    const timing = running.get(file.fileId)
    running.delete(file.fileId)
    const fileIndex = files.length
    let ended = 0
    let failed = 0
    let skipped = 0
    let todo = 0
    // A file that failed whole after its tests ended lists none of them, as the other reporters have it.
    if (entry !== undefined && result.resultsDiscarded !== true) {
      for (const test of entry.tests.values()) {
        const outcome = outcomeOf(entry, test)
        const state = outcome.result?.state
        let status: TestStatus = 0
        if (outcome.failed) status = 1
        else if (state === undefined || state === 'queued' || state === 'running') status = 4
        else if (state === 'skip') status = 2
        else if (state === 'todo') status = 3
        if (status !== 4) ended++
        if (status === 1) failed++
        if (status === 2 || status === 3) skipped++
        if (status === 3) todo++
        tests.push([
          fileIndex,
          test.fullName.map((title) => table.intern(title)),
          status,
          roundMs(outcome.result?.durationMs ?? 0),
        ])
        if (status !== 1) continue
        if (failures.length < MAX_FAILURES) {
          failures.push([tests.length - 1, failureText(outcome.errors, record.root)])
        } else {
          omitted++
        }
      }
    }
    const own =
      entry === undefined
        ? result.errors
        : [...result.errors, ...suiteErrorsOf(entry), ...entry.unhandled]
    const crashed = result.workerExit !== undefined
    let ownText = own.length === 0 ? '' : failureText(own, record.root)
    if (crashed && ownText === '' && result.workerExit !== undefined) {
      ownText = `The worker ${describeExit(result.workerExit)} while it ran this file.`
    }
    if (ownText !== '') fileErrors.push([fileIndex, ownText])
    let status: FileStatus = 4
    if (!crashed) {
      const kind = failed > 0 ? 'fail' : fileKind(result.state, ended, skipped, todo)
      status = kind === 'pass' ? 0 : kind === 'fail' ? 1 : kind === 'skip' ? 2 : 3
    }
    files.push([
      table.intern(file.runPath ?? file.path),
      status,
      roundMs(result.durationMs),
      timing?.workerId ?? -1,
      timing?.startMs ?? -1,
      timing === undefined ? -1 : endMs,
      file.expectedMs === undefined ? -1 : Math.round(file.expectedMs),
      table.intern(file.project),
    ])
  }

  return {
    name: 'html',

    ...handlers,

    'run:start'(info, list) {
      handlers['run:start'](info, list)
      table = createStringTable()
      files = []
      tests = []
      failures = []
      fileErrors = []
      omitted = 0
      workers = info.workers ?? 0
      running = new Map()
      compacted = new Set()
      origin = now()
    },

    'file:start'(file, workerId) {
      running.set(file.fileId, { startMs: Math.round(now() - origin), workerId })
    },

    // The file is over (an event for it after this is dropped): its rows, and its record goes.
    'file:end'(result) {
      handlers['file:end'](result)
      compact(result, Math.round(now() - origin))
      release(result.file.fileId)
    },

    // An error charged to a file that has ended can't join its rows: it is one of the run's.
    unhandled(file, event) {
      if (file !== null && isReleased(file.fileId)) {
        record.runErrors.push({ error: event.error, unhandled: true })
        return
      }
      handlers.unhandled(file, event)
    },

    async 'run:end'(summary) {
      // A file the bus never ended (the summary has it all the same) still gets its row.
      for (const result of summary.files) compact(result, -1)
      const counters = summary.snapshots?.counters
      const data: ReportData = {
        version: 1,
        title: basename(record.root) || record.root,
        startedAt: record.startedAt,
        durationMs: Math.round(summary.durationMs),
        reason: summary.reason,
        workers,
        strings: table.strings,
        files,
        tests,
        failures,
        fileErrors,
        runErrors: record.runErrors.map(({ error }) => failureText([error], record.root)),
        omitted,
        ...(counters === undefined || counters.total === 0
          ? {}
          : {
              snapshots: {
                total: counters.total,
                matched: counters.matched,
                unmatched: counters.unmatched,
                added: counters.added,
                updated: counters.updated,
                unchecked: counters.unchecked,
              },
            }),
      }
      await writeAtomically(resolve(options.outputFile), renderDocument(data))
    },
  }
}
