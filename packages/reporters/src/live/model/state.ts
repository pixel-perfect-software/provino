// The run as the footer needs it, and nothing more (performance rule 4): the totals, one slot per
// worker, the ring of finished files that wait for a frame, and the five slowest files. Every
// method is constant work (`start` is O(files), once per run). Phase 2 extends the records with
// failures and console lines; they stay bounded and are released at `file:end`.

import type { FileInfo, FileResult, SerializedError, SourceLocation, TaskId } from '@provino/types'

/** A failed test as the file's record keeps it until the file ends. */
export interface FailedTest {
  /** Describe titles, then the test's own: the collected task's `fullName`, not copied. */
  readonly title: readonly string[]
  readonly location: SourceLocation | null
  readonly errors: readonly SerializedError[]
}

/** One console write of a running file, text capped at `CONSOLE_TEXT_CAP`. */
export interface ConsoleEntry {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

/** An error outside any file's tests, waiting to be printed. */
export interface RunBlock {
  readonly kind: 'error' | 'unhandled'
  /** An `error` event's origin, or the path of the file an unhandled error is charged to. */
  readonly subject: string | null
  readonly errors: readonly SerializedError[]
}

/** The most failed tests a running file keeps; the rest are counted. */
export const MAX_FILE_FAILURES = 50
/** The most console writes a running file keeps; the rest are counted. */
export const MAX_FILE_CONSOLE = 20
/** The longest console write kept, in characters. */
export const CONSOLE_TEXT_CAP = 4096
/** The most error blocks waiting for a frame; the rest are counted. */
export const MAX_BLOCKS = 200

/** A running file, on a worker's slot. */
export interface WorkerSlot {
  readonly fileId: TaskId
  readonly path: string
  readonly startedAt: number
  /** How long the file is expected to take (`FileInfo.expectedMs`). */
  readonly expectedMs: number | undefined
  /** Tests that ended so far. */
  tests: number
  /** Of those, how many failed. */
  failed: number
  /** Of those, how many were skipped or todo. */
  skipped: number
  readonly failures: FailedTest[]
  failuresOmitted: number
  readonly console: ConsoleEntry[]
  consoleOmitted: number
}

/** A file that ended and has not been drawn yet. */
export interface FinishedFile {
  readonly result: FileResult
  readonly tests: number
  readonly failed: number
  readonly skipped: number
  readonly failures: readonly FailedTest[]
  readonly failuresOmitted: number
  readonly console: readonly ConsoleEntry[]
  readonly consoleOmitted: number
}

/** A file's place among the slowest. */
export interface SlowFile {
  readonly path: string
  readonly durationMs: number
}

/** How many slowest files are kept. */
export const SLOWEST = 5
/** How many finished files can wait for a frame before the oldest are counted, not kept. */
export const RING_CAPACITY = 4096

/** The totals of a run's tests. */
export interface Counts {
  passed: number
  failed: number
  skipped: number
  todo: number
}

/**
 * The state the live reporter keeps.
 * @beta
 */
export interface RunState {
  readonly counts: Counts
  /** Files announced at `run:start`. */
  filesTotal(): number
  filesDone(): number
  filesFailed(): number
  /** Errors outside any test (`error` and `unhandled` events). */
  errors(): number
  /** `now()` at `run:start`. */
  startedAt(): number
  /** The worker slots by `workerId`; a slot with no file is `undefined`. */
  workers(): readonly (WorkerSlot | undefined)[]
  /** Workers with a file. */
  busy(): number
  /** Running files the state tracks by file: never more than `busy`. */
  running(): number
  /** The files that finished and wait for a frame: `take` hands them over and empties the ring. */
  take(): readonly FinishedFile[]
  /** Finished files the ring had no room for since the last `take`. */
  dropped(): number
  slowest(): readonly SlowFile[]
  /** Something a frame shows has changed since `clean`. */
  dirty(): boolean
  clean(): void

  start(files: readonly FileInfo[], now: number): void
  fileStart(file: FileInfo, workerId: number, now: number): void
  /** A test ended in `state` in `fileId`'s file; a failed test brings its `failure`. */
  testEnd(
    fileId: TaskId,
    state: 'pass' | 'fail' | 'skip' | 'todo' | 'queued' | 'running',
    failure?: FailedTest,
  ): void
  /** A running file wrote to the console. A write for a file that is not running is counted, not kept. */
  console(fileId: TaskId, stream: 'stdout' | 'stderr', text: string): void
  /** Console writes that arrived after their file ended (a worker's wind-down), or for a file never started. */
  lateConsole(): number
  fileEnd(result: FileResult): void
  /** An error outside the tests: counted, and its block queued for a frame. */
  error(block?: RunBlock): void
  /** The blocks waiting for a frame, in order; empties the queue. */
  takeBlocks(): readonly RunBlock[]
  /** Blocks the queue had no room for since the last `takeBlocks`. */
  blocksDropped(): number
  /** The run is over: releases the running files' records. */
  finish(): void
}

/**
 * Creates an empty state.
 * @beta
 */
export function createRunState(): RunState {
  const counts: Counts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
  let filesTotal = 0
  let filesDone = 0
  let filesFailed = 0
  let errors = 0
  let startedAt = 0
  let busy = 0
  let dirty = false
  let dropped = 0
  let blocks: RunBlock[] = []
  let blocksDropped = 0
  let lateConsole = 0
  const workers: (WorkerSlot | undefined)[] = []
  /** The running files, by file, so a test's end finds its slot. */
  const byFile = new Map<TaskId, WorkerSlot>()
  /** The ring: a circular buffer with `head` the oldest and `size` the filled. */
  const ring: (FinishedFile | undefined)[] = new Array<FinishedFile | undefined>(RING_CAPACITY)
  let head = 0
  let size = 0
  const slowest: SlowFile[] = []

  return {
    counts,
    filesTotal: () => filesTotal,
    filesDone: () => filesDone,
    filesFailed: () => filesFailed,
    errors: () => errors,
    startedAt: () => startedAt,
    workers: () => workers,
    busy: () => busy,
    running: () => byFile.size,
    take() {
      const out: FinishedFile[] = []
      for (let i = 0; i < size; i++) {
        const index = (head + i) % RING_CAPACITY
        out.push(ring[index] as FinishedFile)
        ring[index] = undefined
      }
      head = 0
      size = 0
      dropped = 0
      return out
    },
    dropped: () => dropped,
    takeBlocks() {
      const out = blocks
      blocks = []
      blocksDropped = 0
      return out
    },
    blocksDropped: () => blocksDropped,
    lateConsole: () => lateConsole,
    finish() {
      workers.length = 0
      byFile.clear()
      busy = 0
    },
    slowest: () => slowest,
    dirty: () => dirty,
    clean() {
      dirty = false
    },

    start(files, now) {
      counts.passed = counts.failed = counts.skipped = counts.todo = 0
      filesTotal = files.length
      filesDone = filesFailed = errors = busy = dropped = 0
      blocks = []
      blocksDropped = 0
      lateConsole = 0
      startedAt = now
      workers.length = 0
      byFile.clear()
      ring.fill(undefined)
      head = size = 0
      slowest.length = 0
      dirty = true
    },
    fileStart(file, workerId, now) {
      const slot: WorkerSlot = {
        fileId: file.fileId,
        path: file.runPath ?? file.path,
        startedAt: now,
        expectedMs: file.expectedMs,
        tests: 0,
        failed: 0,
        skipped: 0,
        failures: [],
        failuresOmitted: 0,
        console: [],
        consoleOmitted: 0,
      }
      // The slot shows the newest file. The previous one keeps its record until its own `file:end`:
      // a run in band announces the next file before the last one has ended, on the same worker
      // (B26 Phase 3 found it: the first file ended with no tests). `finish` releases what never ends.
      if (workers[workerId] === undefined) busy++
      workers[workerId] = slot
      byFile.set(file.fileId, slot)
      dirty = true
    },
    console(fileId, stream, text) {
      const slot = byFile.get(fileId)
      if (slot === undefined) {
        lateConsole++
        return
      }
      if (slot.console.length >= MAX_FILE_CONSOLE) slot.consoleOmitted++
      else
        slot.console.push({
          stream,
          text: text.length > CONSOLE_TEXT_CAP ? text.slice(0, CONSOLE_TEXT_CAP) : text,
        })
    },
    testEnd(fileId, state, failure) {
      switch (state) {
        case 'pass':
          counts.passed++
          break
        case 'fail':
          counts.failed++
          break
        case 'skip':
          counts.skipped++
          break
        case 'todo':
          counts.todo++
          break
        default:
          return
      }
      const slot = byFile.get(fileId)
      if (slot !== undefined) {
        slot.tests++
        if (state === 'fail') {
          slot.failed++
          if (failure !== undefined) {
            if (slot.failures.length >= MAX_FILE_FAILURES) slot.failuresOmitted++
            else slot.failures.push(failure)
          }
        } else if (state === 'skip' || state === 'todo') slot.skipped++
      }
      dirty = true
    },
    fileEnd(result) {
      const id = result.file.fileId
      const slot = byFile.get(id)
      byFile.delete(id)
      if (slot !== undefined) {
        // The slot that holds this very record is cleared; a worker that already took another
        // file keeps its slot.
        const index = workers.indexOf(slot)
        if (index !== -1) {
          workers[index] = undefined
          busy--
        }
      }
      filesDone++
      if (result.state === 'fail') filesFailed++
      if (size === RING_CAPACITY) {
        head = (head + 1) % RING_CAPACITY
        size--
        dropped++
      }
      ring[(head + size) % RING_CAPACITY] = {
        result,
        tests: slot?.tests ?? 0,
        failed: slot?.failed ?? 0,
        skipped: slot?.skipped ?? 0,
        failures: slot?.failures ?? [],
        failuresOmitted: slot?.failuresOmitted ?? 0,
        console: slot?.console ?? [],
        consoleOmitted: slot?.consoleOmitted ?? 0,
      }
      size++
      noteSlow(slowest, {
        path: result.file.runPath ?? result.file.path,
        durationMs: result.durationMs,
      })
      dirty = true
    },
    error(block) {
      errors++
      if (block !== undefined) {
        if (blocks.length >= MAX_BLOCKS) blocksDropped++
        else blocks.push(block)
      }
      dirty = true
    },
  }
}

/** Keeps `slowest` the `SLOWEST` longest files, longest first. A fixed-size insertion, O(SLOWEST). */
function noteSlow(slowest: SlowFile[], file: SlowFile): void {
  if (
    slowest.length === SLOWEST &&
    file.durationMs <= (slowest[SLOWEST - 1] as SlowFile).durationMs
  ) {
    return
  }
  let at = slowest.length
  while (at > 0 && (slowest[at - 1] as SlowFile).durationMs < file.durationMs) at--
  slowest.splice(at, 0, file)
  if (slowest.length > SLOWEST) slowest.pop()
}
