// The report's data as it crosses into the page: plain JSON, compact rows over one string table.
// Types only, so the page's own project (no Node types, `lib.dom`) and the reporter share them
// without either importing the other.

/** How a file ended: 0 passed, 1 failed, 2 skipped, 3 only todo tests, 4 its worker died. */
export type FileStatus = 0 | 1 | 2 | 3 | 4

/** How a test ended: 0 passed, 1 failed, 2 skipped, 3 todo, 4 collected but never ended. */
export type TestStatus = 0 | 1 | 2 | 3 | 4

/**
 * One file, in the order the files ended: path (a string id), status, time in ms, the worker that
 * ran it (`-1` for a file no `file:start` announced), its start and end in ms from the run's
 * start (`-1` when unknown), the time it was expected to take (`-1` when the run had none), and the
 * project's display name (a string id; the empty string's id when it has none).
 */
export type FileRow = readonly [
  pathId: number,
  status: FileStatus,
  ms: number,
  workerId: number,
  startMs: number,
  endMs: number,
  expectedMs: number,
  projectId: number,
]

/** One test: its file's index, its title path (string ids: describe titles, then its own), status, time in ms. */
export type TestRow = readonly [
  fileIndex: number,
  titleIds: readonly number[],
  status: TestStatus,
  ms: number,
]

/** A failed test's error text: the test's index and the text (at most 16 KB). */
export type FailureRow = readonly [testIndex: number, text: string]

/** A file's own error text (a collection error, a dead worker, a failing `afterAll`). */
export type FileErrorRow = readonly [fileIndex: number, text: string]

/** The run's snapshot totals; the report has it only when a file checked or wrote snapshots. */
export interface SnapshotTotals {
  readonly total: number
  readonly matched: number
  readonly unmatched: number
  readonly added: number
  readonly updated: number
  readonly unchecked: number
}

/** Why a run ended. */
export type EndReason = 'passed' | 'failed' | 'interrupted' | 'terminated' | 'hangup'

/** Everything the page shows. */
export interface ReportData {
  readonly version: 1
  /** The page's heading: the project's directory name. */
  readonly title: string
  /** The wall clock at the start of the run, ISO 8601. */
  readonly startedAt: string
  readonly durationMs: number
  readonly reason: EndReason
  /** The pool's worker cap; `0` when the run didn't say. */
  readonly workers: number
  /** Every path, title and project name, once. */
  readonly strings: readonly string[]
  readonly files: readonly FileRow[]
  readonly tests: readonly TestRow[]
  readonly failures: readonly FailureRow[]
  readonly fileErrors: readonly FileErrorRow[]
  /** Errors that belong to no file. */
  readonly runErrors: readonly string[]
  /** Failed tests whose text was not kept (the report keeps the first `MAX_FAILURES`). */
  readonly omitted: number
  readonly snapshots?: SnapshotTotals
}
