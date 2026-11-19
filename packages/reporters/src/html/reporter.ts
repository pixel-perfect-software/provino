import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { FileResult, Reporter, TaskId, WorkerExit } from '@provino/types'
import { createCollector, outcomeOf, suiteErrorsOf } from '../internal/collect.ts'
import { type FileKind, fileKind } from '../internal/views/folders.ts'
import { writeAtomically } from '../internal/write-file.ts'
import { createStringTable, failureText, MAX_FAILURES, roundMs } from './data.ts'
import type {
  FailureRow,
  FileErrorRow,
  FileRow,
  FileStatus,
  ReportData,
  TestRow,
  TestStatus,
} from './page/model.ts'
import { renderDocument } from './render.ts'

/**
 * Options for `htmlReporter`.
 * @beta
 */
export interface HtmlReporterOptions {
  /** Where the page is written, atomically; its directory is created. The page is never written to a stream. */
  readonly outputFile: string
  /**
   * A monotonic clock in milliseconds, read when a file starts and when it ends, for the timeline
   * (D139). Default: `performance.now`.
   */
  readonly now?: () => number
  /** The wall clock in epoch milliseconds, for the run's start time. Default: `Date.now`. */
  readonly wallClock?: () => number
  /** The seed of a randomized run (`--showSeed`, `--randomize`); the page shows it when there is one. */
  readonly seed?: number
  /** `true` for a made-up sample run (`sample-cli.ts`): the page says so. */
  readonly sample?: true
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

/** A test that ended in a state other than a pass, as the data writes it (4: it never ended). */
const TEST_STATUS: Readonly<Record<string, TestStatus>> = {
  queued: 4,
  running: 4,
  skip: 2,
  todo: 3,
}

/** A file's kind as the data writes it. */
const FILE_STATUS: Readonly<Record<FileKind, FileStatus>> = { pass: 0, fail: 1, skip: 2, todo: 3 }

/** The root as the run named it and, when it differs, its real path (a symlinked root's frames hold that). */
function rootsOf(named: string): readonly string[] {
  let real = named
  try {
    real = realpathSync(named)
  } catch {
    // A root that can't be resolved is left as it was named.
  }
  return real === named ? [named] : [named, real]
}

/** What one run keeps: compact rows over one string table, and where each started file is. */
function newRun(): {
  table: ReturnType<typeof createStringTable>
  files: FileRow[]
  tests: TestRow[]
  failures: FailureRow[]
  fileErrors: FileErrorRow[]
  omitted: number
  /** Files that started and have not ended: where and when. */
  running: Map<TaskId, { readonly startMs: number; readonly workerId: number }>
  compacted: Set<TaskId>
  roots: readonly string[]
} {
  return {
    table: createStringTable(),
    files: [],
    tests: [],
    failures: [],
    fileErrors: [],
    omitted: 0,
    running: new Map(),
    compacted: new Set(),
    roots: [],
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
    ...(options.wallClock === undefined ? {} : { now: options.wallClock }),
    console: false,
  })
  let run = newRun()
  let origin = 0

  /**
   * The file as rows, once: its tests, its own error text and its place on the timeline. `endMs` is
   * when the file ended: its `file:end`'s time, or for a file that started and never ended (a killed
   * worker, an interrupted run) the run's end, so no row ends before it starts.
   */
  function compact(result: FileResult, endMs: number): void {
    const { file } = result
    const { table, files, tests, failures, fileErrors, running, compacted, roots } = run
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
        else if (state === undefined) status = 4
        else status = TEST_STATUS[state] ?? 0
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
          failures.push([tests.length - 1, failureText(outcome.errors, roots)])
        } else {
          run.omitted++
        }
      }
    }
    const own =
      entry === undefined
        ? result.errors
        : [...result.errors, ...suiteErrorsOf(entry), ...entry.unhandled]
    let ownText = own.length === 0 ? '' : failureText(own, roots)
    if (ownText === '' && result.workerExit !== undefined) {
      ownText = `The worker ${describeExit(result.workerExit)} while it ran this file.`
    }
    if (ownText !== '') fileErrors.push([fileIndex, ownText])
    const kind = failed > 0 ? 'fail' : fileKind(result.state, ended, skipped, todo)
    files.push([
      table.intern(file.runPath ?? file.path),
      result.workerExit === undefined ? FILE_STATUS[kind] : 4,
      roundMs(result.durationMs),
      timing?.workerId ?? -1,
      timing?.startMs ?? -1,
      timing === undefined ? -1 : Math.max(timing.startMs, endMs),
      file.expectedMs === undefined ? -1 : Math.round(file.expectedMs),
      table.intern(file.project),
    ])
  }

  return {
    name: 'html',

    ...handlers,

    'run:start'(info, list) {
      handlers['run:start'](info, list)
      run = newRun()
      run.roots = rootsOf(record.root)
      origin = now()
    },

    'file:start'(file, workerId) {
      run.running.set(file.fileId, { startMs: Math.round(now() - origin), workerId })
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
      // A file the bus never ended (the summary has it all the same) still gets its row; one that
      // started is cut off at the run's end.
      const runEnd = Math.round(now() - origin)
      for (const result of summary.files) compact(result, runEnd)
      const counters = summary.snapshots?.counters
      const data: ReportData = {
        version: 1,
        // The directory's name only: the run's path stays out of the page (a shared report must not name a CI checkout).
        title: basename(record.root) || record.root,
        startedAt: record.startedAt,
        durationMs: Math.round(summary.durationMs),
        reason: summary.reason,
        strings: run.table.strings,
        files: run.files,
        tests: run.tests,
        failures: run.failures,
        fileErrors: run.fileErrors,
        runErrors: record.runErrors.map(({ error }) => failureText([error], run.roots)),
        omitted: run.omitted,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.sample === true ? { sample: true as const } : {}),
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
      // The rows are written: the run's memory goes with them.
      run = newRun()
    },
  }
}
