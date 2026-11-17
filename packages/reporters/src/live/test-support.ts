// Helpers for the live renderer's tests (not a test file): a clock whose timers a test runs by
// hand, a frame scheduler that draws only when a test says so, and a sink that keeps every write.

import type { FrameCallback, FrameScheduler, SchedulerTimers } from './terminal/scheduler.ts'
import type { TerminalStream } from './terminal/writer.ts'
/** A fake clock with timers: time moves only when a test calls `advance`. */
export interface FakeClock {
  now(): number
  /** Moves time forward by `ms`, running each timer that falls due, in order. */
  advance(ms: number): void
  readonly timers: SchedulerTimers
  /** Timers waiting. */
  pending(): number
  /** How many timers had `unref()` called on them. */
  unrefs(): number
}

export function fakeClock(start = 0): FakeClock {
  let time = start
  let unrefCount = 0
  let nextId = 0
  const waiting = new Map<number, { at: number; callback: () => void }>()
  const handles = new Map<{ unref(): unknown }, number>()
  return {
    now: () => time,
    advance(ms) {
      const target = time + ms
      for (;;) {
        let next: [number, { at: number; callback: () => void }] | undefined
        for (const entry of waiting) {
          if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at))
            next = entry
        }
        if (next === undefined) break
        waiting.delete(next[0])
        time = Math.max(time, next[1].at)
        next[1].callback()
      }
      time = target
    },
    timers: {
      setTimeout(callback, ms) {
        const id = nextId++
        waiting.set(id, { at: time + ms, callback })
        const handle = {
          unref: () => {
            unrefCount++
            return handle
          },
        }
        handles.set(handle, id)
        return handle
      },
      clearTimeout(handle) {
        const id = handles.get(handle)
        if (id !== undefined) waiting.delete(id)
      },
    },
    pending: () => waiting.size,
    unrefs: () => unrefCount,
  }
}

/** A `FrameScheduler` that runs a frame only when a test calls `tick()`. */
export interface ManualScheduler extends FrameScheduler {
  /** Runs the frame if one was requested (or asked for by the last frame); returns whether it ran. */
  tick(): boolean
  /** How many times `request` was called. */
  readonly requests: () => number
  readonly stopped: () => boolean
  /** The write times `observeWrite` was told. */
  readonly writes: readonly number[]
  /** How many times `now` was read. */
  readonly clockReads: () => number
  /** The clock, which a test moves. */
  readonly clock: { now(): number; advance(ms: number): void }
}

export function manualScheduler(
  clock: { now(): number; advance(ms: number): void } = fakeClock(),
): ManualScheduler {
  let frame: FrameCallback | undefined
  let wanted = false
  let requests = 0
  let reads = 0
  let stopped = false
  const writes: number[] = []
  return {
    bind(callback) {
      frame = callback
      stopped = false
    },
    request() {
      requests++
      if (!stopped) wanted = true
    },
    observeWrite: (ms) => {
      writes.push(ms)
    },
    stop() {
      stopped = true
      wanted = false
    },
    now: () => {
      reads++
      return clock.now()
    },
    tick() {
      if (!wanted || frame === undefined || stopped) return false
      wanted = false
      if (frame() !== undefined) wanted = true
      return true
    },
    requests: () => requests,
    stopped: () => stopped,
    writes,
    clockReads: () => reads,
    clock,
  }
}

/** A terminal stream that keeps every write. */
export interface RecordingSink extends TerminalStream {
  writes(): readonly string[]
  text(): string
  /** Makes `write` return false, as a full pipe does, until `drain()`. */
  full: boolean
  drain(): void
}

/**
 * A sink for a renderer's frames. With `writeMs`, each `write` takes that long on `clock`: a fake
 * clock is advanced by it, a real one is spun on.
 */
export function recordingSink(
  options: {
    readonly writeMs?: number
    readonly clock?: { now(): number; advance?(ms: number): void }
  } = {},
): RecordingSink {
  const chunks: string[] = []
  const listeners: (() => void)[] = []
  const sink: RecordingSink = {
    full: false,
    write(chunk) {
      chunks.push(chunk)
      const { writeMs, clock } = options
      if (writeMs !== undefined && clock !== undefined) {
        if (clock.advance !== undefined) clock.advance(writeMs)
        else {
          const start = clock.now()
          while (clock.now() - start < writeMs) {
            // Spin: a terminal that is slow to write holds the caller.
          }
        }
      }
      return !sink.full
    },
    once(_event, listener) {
      listeners.push(listener)
      return sink
    },
    drain() {
      sink.full = false
      for (const listener of listeners.splice(0)) listener()
    },
    writes: () => chunks,
    text: () => chunks.join(''),
  }
  return sink
}
