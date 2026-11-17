// The `provino` reporter: the live footer (a status line and a line per busy worker), the finished
// files with their console, failures and code frames, and the end card. The six performance
// rules (B26) are the shape of it:
//
// 1. A bus handler only updates `RunState` and asks for a frame. It builds no string, measures no
//    width, writes nothing and awaits nothing. `run:end` is the one exception: nobody waits for it.
// 2. Frames are drawn on the scheduler's unref'd timer. With no terminal there is no timer: a
//    `setImmediate` per batch.
// 3. A frame is one write. 4. The state is bounded. 5. This code loads only when chosen.
// 6. Lines are rebuilt only when their inputs change.

import type {
  FileInfo,
  Reporter,
  RunSummary,
  RuntimeEventOf,
  SerializedError,
  TaskId,
} from '@provino/types'
import { serializeError } from '../internal/serialize-error.ts'
import { groupByFolder } from '../internal/views/folders.ts'
import type { TextSink } from '../sink.ts'
import { createStyle, type Style } from '../style.ts'
import { boundError, boundErrors } from './model/bound.ts'
import { createEstimator } from './model/estimate.ts'
import { fileOutcome } from './model/file-outcome.ts'
import { createRunState, type FinishedFile, type RunState } from './model/state.ts'
import { createTreeStore, type TreeFile, type TreeStore } from './model/tree-store.ts'
import type { Glyphs } from './terminal/glyphs.ts'
import {
  createFrameScheduler,
  createImmediateFlusher,
  type FrameScheduler,
  type SchedulerTimers,
} from './terminal/scheduler.ts'
import { createTerminalSession, type TerminalSession } from './terminal/session.ts'
import { createTimedWriter, type TerminalStream } from './terminal/writer.ts'
import type { Snippet } from './view/code-frame.ts'
import { endCardLines } from './view/end-card.ts'
import {
  CODE_FRAME_WAIT_MS,
  createSnippetLoader,
  errorBlockLines,
  type FailureContext,
  type FailurePlace,
  failureLines,
  failureSummaryLine,
  NO_PLACE,
  placeOf,
  readSourceCapped,
  snippetKey,
} from './view/failure.ts'
import { consoleLines, fileLine, fileSnapshotLine } from './view/file-line.ts'
import { mapLines } from './view/map.ts'
import { type StatusInput, statusLine } from './view/status-line.ts'
import { treeLines } from './view/tree.ts'
import { moreWorkersLine, workerLine } from './view/worker-line.ts'

/** How many worker lines the footer shows; more busy workers are counted on one line. */
export const MAX_WORKER_LINES = 8
/** How long the spinner and the clocks wait between frames when nothing else changes. */
const TICK_MS = 120
/** How soon a frame looks again at a file that waits for its source. */
const HOLD_POLL_MS = 50
/** The failures the end card lists again; the rest are counted. */
const MAX_LISTED_FAILURES = 200

/** A finished file taken from the ring: drawn once its code frames have been read, or have waited long enough. */
interface Held {
  readonly finished: FinishedFile
  /** Where each failure happened, worked out once when the file is taken. */
  readonly places: readonly FailurePlace[]
  readonly heldAt: number
  snippets: ReadonlyMap<string, Snippet> | undefined
  ready: boolean
}

/**
 * The views the `provino` reporter prints besides its live output (`--tree`, `--map`).
 * @beta
 */
export interface ProvinoViews {
  /**
   * The run folder by folder after its lines, before the end card: a passing file is one row,
   * and a file with a failure opens down to the failed tests.
   */
  readonly tree?: true
  /** One cell per file, a row per folder, after the end card. */
  readonly map?: true
}

/**
 * What the `provino` reporter takes.
 * @beta
 */
export interface ProvinoReporterOptions {
  readonly stream: TerminalStream
  /** `detectOutput`'s `live`: draw the footer. Without it nothing is redrawn and no timer runs. */
  readonly live: boolean
  readonly colour: boolean
  readonly columns: number
  readonly glyphs: Glyphs
  /** Draw file paths and locations as OSC 8 hyperlinks (`detectHyperlinks`' answer). */
  readonly hyperlinks: boolean
  /** The run's root: code frames are read from it and paths show relative to it. */
  readonly cwd: string
  /** Print no console output under the files. */
  readonly silent?: true
  /** Print no location and no code frame under a failure. */
  readonly noStackTrace?: true
  /** The run's random seed, shown in the end card (the caller decides when: `--showSeed`, `--randomize`). */
  readonly seed?: number
  /**
   * How to update snapshots, in the words the run was started with (`re-run with \`-u\``): the
   * end card shows it under the snapshot line when some failed or are obsolete.
   */
  readonly snapshotHint?: string
  /** The views to print after the run. Each costs memory the plain run does not: `tree` keeps the failed files' trees, both keep a row per file. */
  readonly views?: ProvinoViews
  /** How a source file is read for a code frame. Default: a read of at most 1 MB. */
  readonly readSource?: (path: string) => Promise<string | undefined>
  /** The clock in ms, for the scheduler this reporter makes. Default: `performance.now`. */
  readonly now?: () => number
  /** The timer that ends a wait for a code frame when there is no terminal. Default: the real one, unref'd. */
  readonly timers?: SchedulerTimers
  /** Tests pass the manual scheduler. Default: the real one, on an unref'd timer. */
  readonly scheduler?: FrameScheduler
}

/**
 * What the process hooks need from the reporter.
 * @beta
 */
export interface LiveTerminal {
  /** Erases the footer and shows the cursor. Idempotent. Call it on `exit`, on a failed frame and at `run:end`. */
  restore(): void
  /** The terminal's width changed. */
  resize(columns: number): void
  /** Text the run writes to stderr itself goes above the footer, at the next frame. */
  readonly passthrough: TextSink
}

/**
 * The `provino` reporter, and the hooks for the terminal it draws on.
 * @beta
 */
export type ProvinoReporter = Reporter & { readonly terminal: LiveTerminal }

/**
 * The reporter over a state of the caller's own, which a test wraps to count what a handler does.
 * @internal
 */
export function createLiveReporter(
  options: ProvinoReporterOptions,
  state: RunState,
  makeTree: () => TreeStore = createTreeStore,
): ProvinoReporter {
  const { stream, live, glyphs } = options
  // The collected trees are kept only under `--tree`: with no flag the store is never made.
  const trees = options.views?.tree === true ? makeTree() : undefined
  const wantsMap = options.views?.map === true
  /**
   * The files that ended, one row each, for the views: taken as each file ends (`file:end`), not
   * when a frame draws it, so the live ring dropping a file (a slow terminal, a long run) never
   * takes it out of a view.
   */
  let viewFiles: TreeFile[] = []
  const style: Style = createStyle(options.colour)
  const scheduler =
    options.scheduler ?? createFrameScheduler(options.now ? { now: options.now } : {})
  const estimator = createEstimator((file) => file.expectedMs)
  const loader = createSnippetLoader({
    cwd: options.cwd,
    read: options.readSource ?? readSourceCapped,
  })
  const writer = createTimedWriter(stream, {
    now: () => scheduler.now(),
    onWrite: (ms) => scheduler.observeWrite(ms),
    onReady: () => scheduler.request(),
    onError: (cause) => {
      // The stream failed while full (EPIPE, a closed pipe): keep the error for the bus; frames stop
      // because the writer is no longer ready.
      lastError = serializeError(cause)
      scheduler.stop()
    },
  })
  let columns = options.columns
  let session: TerminalSession | undefined
  let broken = false
  let lastError: SerializedError | undefined
  let frameNo = 0
  /** The terminal was resized since the last frame: draw it whole even if no line changed. */
  let redrawWanted = false
  /** The run is over, or the terminal was restored: no frame will come, so text goes straight out. */
  let detached = false
  /** Files out of the ring, waiting (in order) for their code frames. */
  let held: Held[] = []
  /** The failures as one line each, for the end card, and how many more there were. */
  let listed: string[] = []
  let listedMore = 0
  /** The pool's worker cap and this run's shard, from `run:start`. */
  let workersCap: number | undefined
  let shardText: string | undefined

  /** Whole lines written to `passthrough`, waiting for the next frame; and the unfinished line. */
  let pending: string[] = []
  let partial = ''
  /** The last line handed to the terminal, so the views can tell whether a blank line is already there. */
  let lastLine: string | undefined

  /** Takes the lines waiting for the terminal, remembering the last of them. */
  function takePending(): string[] {
    const taken = pending
    if (taken.length > 0) lastLine = taken[taken.length - 1]
    pending = []
    return taken
  }

  // Cached lines (performance rule 6).
  let statusKey = ''
  let statusText = ''
  /** The rule over the footer, made again only when the width changes. */
  let ruleColumns = 0
  let ruleText = ''
  const workerKeys: string[] = []
  const workerTexts: string[] = []

  // The text is handed to the writer, which keeps it while the stream is full and writes it on
  // `drain`: a non-live run needs no retry timer of its own.
  function flushPlain(): void {
    drain(false, scheduler.now())
    if (pending.length === 0) return
    writer.writeAlways(`${takePending().join('\n')}\n`)
  }
  const flusher = createImmediateFlusher(flushPlain)
  const timers: SchedulerTimers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  }
  let holdTimer: { unref(): unknown } | undefined

  /** Asks for the next write: a frame on a terminal, a flush of the batch without one. */
  function wake(now?: number): void {
    if (live && !broken) scheduler.request(now)
    else flusher.schedule()
  }

  function statusInput(now: number): StatusInput {
    return {
      passed: state.counts.passed,
      failed: state.counts.failed,
      skipped: state.counts.skipped,
      todo: state.counts.todo,
      filesDone: state.filesDone(),
      filesTotal: state.filesTotal(),
      elapsedMs: now - state.startedAt(),
      leftMs: estimator.leftMs(now),
      ...(shardText === undefined ? {} : { shard: shardText }),
    }
  }

  function context(): FailureContext {
    return {
      glyphs,
      style,
      columns,
      hyperlinks: options.hyperlinks,
      cwd: options.cwd,
      colour: options.colour,
    }
  }

  /** Takes a finished file out of the ring: finds where its failures happened and starts reading their source. */
  function admit(finished: FinishedFile, now: number): Held {
    const { failures } = finished
    const places =
      failures.length === 0 || options.noStackTrace === true
        ? failures.map(() => NO_PLACE)
        : failures.map((failure) => placeOf(failure, options.cwd))
    const item: Held = { finished, places, heldAt: now, snippets: undefined, ready: true }
    if (failures.length === 0 || options.noStackTrace === true) return item
    const wanted = places.flatMap((place) => (place.where === undefined ? [] : [place.where]))
    const reading = loader.load(wanted)
    if (reading === undefined) return item
    item.ready = false
    const settle = (snippets: ReadonlyMap<string, Snippet> | undefined): void => {
      item.snippets = snippets
      item.ready = true
      wake()
    }
    reading.then(settle, () => settle(undefined))
    return item
  }

  function listFailure(line: string): void {
    if (listed.length < MAX_LISTED_FAILURES) listed.push(line)
    else listedMore++
  }

  /** A finished file's lines, built once: its line, its console, its failures, its own errors. */
  function render(item: Held): string[] {
    const { result, tests, failed, skipped, failures, failuresOmitted, console, consoleOmitted } =
      item.finished
    const path = result.file.runPath ?? result.file.path
    const ctx = context()
    const lines = [
      fileLine(
        {
          path,
          project: result.file.project,
          state: result.state,
          tests,
          failed,
          skipped,
          durationMs: result.durationMs,
          ...(result.heapUsedBytes === undefined ? {} : { heapBytes: result.heapUsedBytes }),
        },
        columns,
        glyphs,
        style,
      ),
    ]
    const snapshotNote =
      result.snapshot === undefined ? undefined : fileSnapshotLine(result.snapshot, columns, style)
    if (snapshotNote !== undefined) lines.push(snapshotNote)
    if (options.silent !== true) {
      lines.push(...consoleLines(console, consoleOmitted, columns, style, options.colour))
    }
    failures.forEach((failure, index) => {
      const place = item.places[index] ?? NO_PLACE
      const snippet =
        place.where === undefined ? undefined : item.snippets?.get(snippetKey(place.where))
      lines.push(...failureLines(failure, place, ctx, snippet))
      listFailure(failureSummaryLine(failure, place, ctx))
    })
    if (failuresOmitted > 0) {
      lines.push(`   ${style.dim(`… ${failuresOmitted} more failed tests in this file`)}`, '')
      listedMore += failuresOmitted
    }
    if (result.errors.length > 0) {
      lines.push(
        ...errorBlockLines(
          failed > 0 ? 'Errors outside the tests' : 'Test suite failed to run',
          result.errors,
          ctx,
        ),
      )
      if (failed === 0) listFailure(`  ${glyphs.fail} ${path}`)
    }
    return lines
  }

  /** The title of an error block, from what `error` and `unhandled` handed over. */
  function blockTitle(kind: 'error' | 'unhandled', subject: string | null): string {
    if (kind === 'unhandled') {
      return subject === null ? 'Unhandled error' : `Unhandled error in ${subject}`
    }
    if (subject === 'reporter') return 'Reporter error'
    if (subject === 'globalSetup') return 'Global setup error'
    return 'Provino error'
  }

  /**
   * Moves what is waiting (error blocks, finished files) into `pending`, in order. A file whose
   * code frames are still being read holds the ones behind it, until they arrive or have waited
   * `CODE_FRAME_WAIT_MS` (on a terminal; with none a read is waited for, and `final` ends the wait).
   */
  function drain(final: boolean, now: number): void {
    const ctx = context()
    const blocksDropped = state.blocksDropped()
    for (const block of state.takeBlocks()) {
      const title = blockTitle(block.kind, block.subject)
      for (const line of errorBlockLines(title, block.errors, ctx)) pending.push(line)
    }
    if (blocksDropped > 0) pending.push(style.dim(`… ${blocksDropped} more errors`))
    const dropped = state.dropped()
    for (const finished of state.take()) held.push(admit(finished, now))
    if (dropped > 0) pending.push(style.dim(`… ${dropped} more files finished`))
    let done = 0
    for (const item of held) {
      const timedOut = now - item.heldAt >= CODE_FRAME_WAIT_MS
      if (!item.ready && !final && !timedOut) break
      for (const line of render(item)) pending.push(line)
      done++
    }
    held = done === held.length ? [] : held.slice(done)
    // With no terminal no frame comes back to end the wait: a one-shot timer does.
    const waiting = held[0]
    if (waiting !== undefined && !(live && !broken) && holdTimer === undefined) {
      const remaining = Math.max(1, CODE_FRAME_WAIT_MS - (now - waiting.heldAt))
      holdTimer = timers.setTimeout(() => {
        holdTimer = undefined
        flushPlain()
      }, remaining)
      holdTimer.unref()
    }
  }

  function footer(now: number): string[] {
    const input = statusInput(now)
    const key = `${input.passed}|${input.failed}|${input.skipped}|${input.todo}|${input.filesDone}|${input.filesTotal}|${Math.floor(input.elapsedMs / 100)}|${input.leftMs === undefined ? '' : Math.round(input.leftMs / 1000)}|${columns}`
    if (key !== statusKey) {
      statusKey = key
      statusText = statusLine(input, columns, glyphs, style)
    }
    if (ruleColumns !== columns) {
      ruleColumns = columns
      ruleText = style.dim(glyphs.rule.repeat(Math.max(1, columns - 1)))
    }
    // The rule, the busy workers, then the bar line at the very bottom.
    const lines = [ruleText]
    const slots = state.workers()
    let shown = 0
    let hidden = 0
    for (let id = 0; id < slots.length; id++) {
      const slot = slots[id]
      if (slot === undefined) continue
      if (shown === MAX_WORKER_LINES) {
        hidden++
        continue
      }
      const elapsed = now - slot.startedAt
      const workerKey = `${slot.path}|${Math.floor(elapsed / 100)}|${frameNo % glyphs.spinner.length}|${columns}`
      if (workerKeys[id] !== workerKey) {
        workerKeys[id] = workerKey
        workerTexts[id] = workerLine(
          id + 1,
          slot.path,
          elapsed,
          frameNo,
          columns,
          glyphs,
          slot.expectedMs,
        )
      }
      lines.push(workerTexts[id] as string)
      shown++
    }
    if (hidden > 0) lines.push(moreWorkersLine(hidden))
    if (
      shown === 0 &&
      workersCap !== undefined &&
      state.filesDone() === 0 &&
      state.filesTotal() > 0
    ) {
      const spinner = glyphs.spinner[frameNo % glyphs.spinner.length] as string
      lines.push(` ${spinner}  starting ${workersCap} worker${workersCap === 1 ? '' : 's'}`)
    }
    lines.push(statusText)
    return lines
  }

  /** One frame. Returns when the next is wanted with nothing else changed. */
  function frame(): number | undefined {
    if (session === undefined || broken) return undefined
    if (!writer.ready()) return undefined
    // Nothing changed and nothing animates (no busy worker): no footer to rebuild, no frame.
    if (
      !redrawWanted &&
      pending.length === 0 &&
      held.length === 0 &&
      !state.dirty() &&
      state.busy() === 0
    ) {
      return undefined
    }
    try {
      const now = scheduler.now()
      frameNo++
      drain(false, now)
      const drawn = session.draw(pending, footer(now))
      if (drawn) {
        takePending()
        redrawWanted = false
      }
      state.clean()
    } catch (cause) {
      breakDown(cause)
      return undefined
    }
    if (held.length > 0) return HOLD_POLL_MS
    return state.busy() > 0 ? TICK_MS : undefined
  }

  /** A frame failed: put the terminal back, keep the error for the bus, go on without a footer. */
  function breakDown(cause: unknown): void {
    broken = true
    scheduler.stop()
    lastError = serializeError(cause)
    try {
      session?.restore()
    } catch {
      // The restore is the last resort; the error kept above is what the run fails on.
    }
  }

  const reporter: ProvinoReporter = {
    name: 'provino',
    terminal: {
      restore() {
        scheduler.stop()
        if (holdTimer !== undefined) timers.clearTimeout(holdTimer)
        holdTimer = undefined
        const wasDetached = detached
        detached = true
        // The footer goes and the cursor comes back first, then what was waiting for a frame (the
        // workers' own text, finished files, error blocks) as plain lines, so a run that ends by
        // throwing or by a signal still shows the output that explains it.
        session?.restore()
        if (wasDetached) return
        if (partial !== '') {
          pending.push(partial)
          partial = ''
        }
        try {
          drain(true, scheduler.now())
        } catch {
          // Rendering what was held is best effort here: the queued text below still goes out.
        }
        if (pending.length === 0) return
        writer.writeSync(`${takePending().join('\n')}\n`)
      },
      resize(width) {
        columns = width
        redrawWanted = true
        session?.resize(width)
        wake()
      },
      passthrough: {
        write(chunk) {
          if (detached) {
            // No frame will come to carry it (the run ended, or the terminal was restored).
            writer.writeAlways(chunk)
            return
          }
          partial += chunk
          const end = partial.lastIndexOf('\n')
          if (end === -1) return
          for (const line of partial.slice(0, end).split('\n')) pending.push(line)
          partial = partial.slice(end + 1)
          wake()
        },
      },
    },
    lastError: () => lastError,

    'run:start': (info, files) => {
      const now = scheduler.now()
      state.start(files, now)
      held = []
      listed = []
      listedMore = 0
      viewFiles = []
      trees?.clear()
      lastLine = undefined
      loader.reset()
      workersCap = info.workers
      shardText =
        info.shard === undefined ? undefined : `shard ${info.shard.index}/${info.shard.count}`
      estimator.reset(files)
      frameNo = 0
      statusKey = ''
      workerKeys.length = 0
      workerTexts.length = 0
      // `pending` and `partial` stay: text written before the run (config warnings, deprecation
      // notices) comes out first, at the first frame or flush. A broken run is over; this one gets
      // a fresh session and `bind` (which lets a stopped scheduler run again).
      detached = false
      redrawWanted = false
      broken = false
      lastError = undefined
      if (live) {
        session = createTerminalSession(writer, columns)
        scheduler.bind(frame)
      }
      wake(now)
    },
    'file:start': (file, workerId) => {
      const now = scheduler.now()
      state.fileStart(file, workerId, now)
      estimator.fileStarted(file, now, state.busy())
      wake(now)
    },
    // Only under `--tree`: with no flag the reporter has no handler for it at all.
    ...(trees === undefined
      ? {}
      : {
          'file:collected': (file: FileInfo, event: RuntimeEventOf<'file-collect-end'>) => {
            trees.collected(file.fileId, event.tasks)
          },
        }),
    'task:end': (task, event) => {
      if (event.type === 'suite-end') {
        if (trees !== undefined && event.result.state === 'fail') {
          const [first] = event.result.errors
          trees.suiteFailed(
            task.fileId,
            task.id,
            first === undefined ? undefined : boundError(first),
          )
        }
        return
      }
      if (event.type !== 'test-end' || task.type !== 'test') return
      if (event.result.state === 'fail') {
        const errors = boundErrors(event.result.errors)
        state.testEnd(task.fileId as TaskId, 'fail', {
          title: task.fullName,
          location: task.location,
          errors,
        })
        trees?.testEnd(task.fileId, task.id, 'fail', event.result.durationMs, errors[0])
      } else {
        state.testEnd(task.fileId as TaskId, event.result.state)
        trees?.testEnd(task.fileId, task.id, event.result.state, event.result.durationMs)
      }
      wake()
    },
    console: (file, event) => {
      if (options.silent === true) return
      state.console(file.fileId as TaskId, event.stream, event.text)
    },
    'file:end': (result) => {
      const now = scheduler.now()
      const finished = state.fileEnd(
        result.errors.length === 0 ? result : { ...result, errors: boundErrors(result.errors) },
      )
      // The views take the file now, apart from the ring: a row of numbers (a map delete for a
      // file that passed, one walk of its own tasks for a file with a failure), so no file is
      // missing from a view and no record outlives its file.
      if (trees !== undefined) viewFiles.push(trees.compact(finished))
      else if (wantsMap) viewFiles.push({ ...fileOutcome(finished), open: undefined })
      estimator.fileEnded(result.file, now, state.busy())
      wake(now)
    },
    error: (error, origin) => {
      state.error({ kind: 'error', subject: origin, errors: [boundError(error)] })
      wake()
    },
    unhandled: (file, event) => {
      state.error({
        kind: 'unhandled',
        subject: file === null ? null : file.path,
        errors: [boundError(event.error)],
      })
      wake()
    },
    'run:end': (summary: RunSummary) => {
      // The one handler that does the work itself: the run is over and no worker waits.
      scheduler.stop()
      if (holdTimer !== undefined) timers.clearTimeout(holdTimer)
      holdTimer = undefined
      detached = true
      if (partial !== '') {
        pending.push(partial)
        partial = ''
      }
      drain(true, scheduler.now())
      state.finish()
      const card = endCardLines(
        {
          ok: summary.reason === 'passed',
          reason: summary.reason,
          passed: state.counts.passed,
          failed: state.counts.failed,
          skipped: state.counts.skipped,
          todo: state.counts.todo,
          filesDone: state.filesDone(),
          filesFailed: state.filesFailed(),
          durationMs: summary.durationMs,
          slowest: state.slowest(),
          snapshots: summary.snapshots?.counters,
          ...(summary.snapshots === undefined ? {} : { snapshotUpdate: summary.snapshots.update }),
          ...(options.snapshotHint === undefined ? {} : { snapshotHint: options.snapshotHint }),
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          openHandles: summary.openHandles,
          lateConsole: state.lateConsole(),
          failures: listed,
          failuresMore: listedMore,
        },
        columns,
        glyphs,
        style,
      )
      // The last block ends in a blank line already: the card's own would make two. The tree goes
      // after the run's lines and before the card, the map after the card, each behind exactly one
      // blank line: before the tree one unless the last line handed over (queued or already
      // written) is blank, before the card the card's own, after the tree's non-blank rows.
      const folders = viewFiles.length === 0 ? [] : groupByFolder(viewFiles)
      const treeBlock =
        trees === undefined || folders.length === 0
          ? []
          : treeLines(folders, columns, glyphs, style)
      const mapBlock =
        !wantsMap || folders.length === 0 ? [] : ['', ...mapLines(folders, columns, glyphs, style)]
      const endsBlank = (pending.length > 0 ? pending[pending.length - 1] : lastLine) === ''
      const lead =
        treeBlock.length === 0 ? pending : [...pending, ...(endsBlank ? [] : ['']), ...treeBlock]
      const cardLines = treeBlock.length === 0 && pending.at(-1) === '' ? card.slice(1) : card
      const lines = [...lead, ...cardLines, ...mapBlock]
      pending = []
      listed = []
      held = []
      viewFiles = []
      trees?.clear()
      if (session !== undefined && !broken) session.finish(lines)
      else writer.writeAlways(`${lines.join('\n')}\n`)
      session = undefined
    },
  }
  return reporter
}

/**
 * Creates the `provino` reporter: Provino's own live terminal output, the same under every
 * dialect.
 * @beta
 */
export function provinoReporter(options: ProvinoReporterOptions): ProvinoReporter {
  return createLiveReporter(options, createRunState())
}
