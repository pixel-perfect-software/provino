// When frames are drawn (performance rules 2 and 3). A frame is drawn on our own unref'd timer, at
// most once per interval and only when something asked for one; the bus handlers only mark state
// and call `request`. The interval is `max(60 ms, 100 x EWMA(write ms))`, capped at 2 s, so a
// terminal whose writes take 5 ms gets a frame every 500 ms: the renderer costs 1% of the loop
// however slow the terminal is.

/** Runs one frame. Returns the milliseconds until another is wanted though nothing asks (a spinner), if any. */
export type FrameCallback = () => number | undefined

/**
 * The timer functions the scheduler needs, `setTimeout` and `clearTimeout` by default; a test
 * passes a fake clock's.
 * @beta
 */
export interface SchedulerTimers {
  setTimeout(callback: () => void, ms: number): { unref(): unknown }
  clearTimeout(handle: { unref(): unknown }): void
}

/**
 * Decides when the reporter's frame runs.
 * @beta
 */
export interface FrameScheduler {
  /** Sets the frame to run, and lets frames run again after a `stop`. The reporter calls it at each `run:start`. */
  bind(frame: FrameCallback): void
  /**
   * Asks for a frame: one runs as soon as the interval since the last allows, at most. A request
   * while one is already due is free. `now` is the time the caller has already read, so a handler
   * reads the clock once.
   */
  request(now?: number): void
  /** The time of a write that has just finished, in ms: it sets the next interval. */
  observeWrite(ms: number): void
  /** Cancels the pending frame. Later requests do nothing. */
  stop(): void
  /** The clock the reporter and the scheduler share, in ms. */
  now(): number
}

/**
 * What `createFrameScheduler` takes.
 * @beta
 */
export interface SchedulerOptions {
  /** Default: `performance.now`. */
  readonly now?: () => number
  readonly timers?: SchedulerTimers
  /** The shortest time between frames. Default 60. */
  readonly minIntervalMs?: number
  /** The longest the backoff reaches. Default 2000. */
  readonly maxIntervalMs?: number
}

/** The weight a new write time gets in the average. */
const EWMA_WEIGHT = 0.3
/** How many writes' worth of time one interval leaves for everything else: a write is 1% of it. */
const BACKOFF = 100

/**
 * The real scheduler: one `setTimeout` at a time, `unref()`'d so it never keeps the process alive.
 * @beta
 */
export function createFrameScheduler(options: SchedulerOptions = {}): FrameScheduler {
  const now = options.now ?? (() => performance.now())
  const timers: SchedulerTimers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  }
  const minInterval = options.minIntervalMs ?? 60
  const maxInterval = options.maxIntervalMs ?? 2000
  let frame: FrameCallback | undefined
  let handle: { unref(): unknown } | undefined
  let dueAt = 0
  let lastFrameAt = Number.NEGATIVE_INFINITY
  let writeMs: number | undefined
  let stopped = false

  const interval = (): number =>
    writeMs === undefined
      ? minInterval
      : Math.min(maxInterval, Math.max(minInterval, BACKOFF * writeMs))

  function arm(at: number, current: number): void {
    dueAt = at
    handle = timers.setTimeout(run, Math.max(0, at - current))
    handle.unref()
  }

  function run(): void {
    handle = undefined
    if (stopped || frame === undefined) return
    lastFrameAt = now()
    const next = frame()
    if (next !== undefined && !stopped && handle === undefined) {
      arm(lastFrameAt + Math.max(interval(), next), now())
    }
  }

  return {
    bind(callback) {
      frame = callback
      stopped = false
    },
    request(current) {
      if (stopped) return
      const at = lastFrameAt + interval()
      if (handle !== undefined) {
        // One is due already; only an earlier time (a spinner's wait cut short) replaces it.
        if (at >= dueAt) return
        timers.clearTimeout(handle)
      }
      arm(at, current ?? now())
    },
    observeWrite(ms) {
      writeMs = writeMs === undefined ? ms : writeMs + EWMA_WEIGHT * (ms - writeMs)
    },
    stop() {
      stopped = true
      if (handle !== undefined) timers.clearTimeout(handle)
      handle = undefined
    },
    now,
  }
}

/**
 * Runs `flush` once per turn of the event loop however many times `schedule` is called in it:
 * the way a run with no terminal writes its finished lines, with no timer at all.
 * @beta
 */
export interface ImmediateFlusher {
  /** Arranges for `flush` to run in a `setImmediate`, unless one is already arranged. */
  schedule(): void
  /** Runs `flush` now and cancels the arranged one. */
  flushNow(): void
}

/**
 * Creates an `ImmediateFlusher` over `flush`. `immediate` is `setImmediate` unless a test passes its own.
 * @beta
 */
export function createImmediateFlusher(
  flush: () => void,
  immediate: (callback: () => void) => unknown = (callback) => setImmediate(callback),
): ImmediateFlusher {
  let scheduled = false
  let generation = 0
  return {
    schedule() {
      if (scheduled) return
      scheduled = true
      const mine = generation
      immediate(() => {
        if (mine !== generation) return
        scheduled = false
        flush()
      })
    },
    flushNow() {
      generation++
      scheduled = false
      flush()
    },
  }
}
