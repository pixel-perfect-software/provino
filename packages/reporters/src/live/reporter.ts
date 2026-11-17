// The `provino` reporter, as far as the renderer core goes: the live footer (a status line and a
// line per busy worker) and the flush at `run:end`. Phase 2 grows it with the finished files' lines
// and failures. The six performance rules (B26) are the shape of it:
//
// 1. A bus handler only updates `RunState` and asks for a frame. It builds no string, measures no
//    width, writes nothing and awaits nothing. `run:end` is the one exception: nobody waits for it.
// 2. Frames are drawn on the scheduler's unref'd timer. With no terminal there is no timer: a
//    `setImmediate` per batch.
// 3. A frame is one write. 4. The state is bounded. 5. This code loads only when chosen.
// 6. Lines are rebuilt only when their inputs change.

import type { FileInfo, Reporter, RunSummary, SerializedError, TaskId } from '@provino/types'
import { serializeError } from '../internal/serialize-error.ts'
import type { TextSink } from '../sink.ts'
import { createStyle, type Style } from '../style.ts'
import { createEstimator } from './model/estimate.ts'
import { createRunState, type RunState } from './model/state.ts'
import type { Glyphs } from './terminal/glyphs.ts'
import {
  createFrameScheduler,
  createImmediateFlusher,
  type FrameScheduler,
} from './terminal/scheduler.ts'
import { createTerminalSession, type TerminalSession } from './terminal/session.ts'
import { createTimedWriter, type TerminalStream } from './terminal/writer.ts'
import { finalStatusLine, type StatusInput, statusLine } from './view/status-line.ts'
import { moreWorkersLine, workerLine } from './view/worker-line.ts'

/** How many worker lines the footer shows; more busy workers are counted on one line. */
export const MAX_WORKER_LINES = 8
/** How long the spinner and the clocks wait between frames when nothing else changes. */
const TICK_MS = 120

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
  /** The clock in ms, for the scheduler this reporter makes. Default: `performance.now`. */
  readonly now?: () => number
  /** Tests pass the manual scheduler. Default: the real one, on an unref'd timer. */
  readonly scheduler?: FrameScheduler
  /** A file's expected time in ms, for the time left (until `FileInfo` carries it). */
  readonly expectedMs?: (file: FileInfo) => number | undefined
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
): ProvinoReporter {
  const { stream, live, glyphs } = options
  const style: Style = createStyle(options.colour)
  const scheduler =
    options.scheduler ?? createFrameScheduler(options.now ? { now: options.now } : {})
  const estimator = createEstimator(options.expectedMs ?? (() => undefined))
  const writer = createTimedWriter(stream, {
    now: () => scheduler.now(),
    onWrite: (ms) => scheduler.observeWrite(ms),
    onReady: () => scheduler.request(),
  })
  let columns = options.columns
  let session: TerminalSession | undefined
  let broken = false
  let lastError: SerializedError | undefined
  let frameNo = 0

  /** Whole lines written to `passthrough`, waiting for the next frame; and the unfinished line. */
  let pending: string[] = []
  let partial = ''

  // Cached lines (performance rule 6).
  let statusKey = ''
  let statusText = ''
  const workerKeys: string[] = []
  const workerTexts: string[] = []

  function flushPlain(): void {
    state.take()
    if (pending.length === 0) return
    writer.write(`${pending.join('\n')}\n`)
    pending = []
  }
  const flusher = createImmediateFlusher(flushPlain)

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
    }
  }

  function footer(now: number): string[] {
    const input = statusInput(now)
    const key = `${input.passed}|${input.failed}|${input.skipped}|${input.todo}|${input.filesDone}|${input.filesTotal}|${Math.floor(input.elapsedMs / 100)}|${input.leftMs === undefined ? '' : Math.round(input.leftMs / 1000)}|${columns}`
    if (key !== statusKey) {
      statusKey = key
      statusText = statusLine(input, columns, glyphs, style)
    }
    const lines = [statusText]
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
        workerTexts[id] = workerLine(id + 1, slot.path, elapsed, frameNo, columns, glyphs)
      }
      lines.push(workerTexts[id] as string)
      shown++
    }
    if (hidden > 0) lines.push(moreWorkersLine(hidden))
    return lines
  }

  /** One frame. Returns when the next is wanted with nothing else changed. */
  function frame(): number | undefined {
    if (session === undefined || broken) return undefined
    if (!writer.ready()) return undefined
    try {
      const now = scheduler.now()
      frameNo++
      state.take()
      const drawn = session.draw(pending, footer(now))
      if (drawn) pending = []
      state.clean()
    } catch (cause) {
      breakDown(cause)
      return undefined
    }
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
        session?.restore()
      },
      resize(width) {
        columns = width
        session?.resize(width)
        wake()
      },
      passthrough: {
        write(chunk) {
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

    'run:start': (_info, files) => {
      const now = scheduler.now()
      state.start(files, now)
      estimator.reset(files)
      frameNo = 0
      statusKey = ''
      workerKeys.length = 0
      workerTexts.length = 0
      pending = []
      partial = ''
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
    'task:end': (task, event) => {
      if (event.type !== 'test-end') return
      state.testEnd(task.fileId as TaskId, event.result.state)
      wake()
    },
    'file:end': (result) => {
      const now = scheduler.now()
      state.fileEnd(result)
      estimator.fileEnded(result.file, now, state.busy())
      wake(now)
    },
    error: () => {
      state.error()
      wake()
    },
    unhandled: () => {
      state.error()
      wake()
    },
    'run:end': (summary: RunSummary) => {
      // The one handler that does the work itself: the run is over and no worker waits.
      scheduler.stop()
      if (!live || broken) flusher.flushNow()
      else state.take()
      if (partial !== '') {
        pending.push(partial)
        partial = ''
      }
      const input: StatusInput = {
        ...statusInput(state.startedAt() + summary.durationMs),
        leftMs: undefined,
        elapsedMs: summary.durationMs,
      }
      const lines = [...pending, finalStatusLine(input, columns, glyphs, style)]
      pending = []
      if (session !== undefined && !broken) session.finish(lines)
      else writer.write(`${lines.join('\n')}\n`)
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
