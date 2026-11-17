// The one place the renderer writes to the terminal (performance rule 3). Each frame is one
// write, timed; a write that returns `false` (a pipe whose reader is slow) pauses frames until the
// stream drains. The restore on `exit` is synchronous, to the stream's file descriptor, because a
// `write` queued on the way out may never run.

import { writeSync } from 'node:fs'

/**
 * What the renderer writes to: a `tty.WriteStream`, a pipe, a test's buffer.
 * @beta
 */
export interface TerminalStream {
  /** A `false` return means the stream's buffer is full: wait for `drain`. */
  write(chunk: string): unknown
  once?(event: 'drain', listener: () => void): unknown
  /** The file descriptor, for the synchronous write on exit. */
  readonly fd?: number | undefined
}

/**
 * What `createTimedWriter` takes.
 * @beta
 */
export interface WriterOptions {
  /** The clock in ms. Default: `performance.now`. */
  readonly now?: () => number
  /** Called with each write's duration in ms. */
  readonly onWrite?: (ms: number) => void
  /** Called when a stream that had paused writes has drained. */
  readonly onReady?: () => void
}

/**
 * Writes frames, timed, pausing while the stream is full.
 * @beta
 */
export interface TimedWriter {
  /** Whether a frame may be written: false while the stream has not drained. */
  ready(): boolean
  /** Writes one frame, if `ready`; returns whether it did. */
  write(text: string): boolean
  /** Writes `text` now, synchronously where the stream has a descriptor. For the restore. */
  writeSync(text: string): void
}

/**
 * Creates the writer for `stream`.
 * @beta
 */
export function createTimedWriter(
  stream: TerminalStream,
  options: WriterOptions = {},
): TimedWriter {
  const now = options.now ?? (() => performance.now())
  let paused = false

  function pause(): void {
    // Without `once` there is nothing to wait for, so the stream is taken as ready.
    if (stream.once === undefined) return
    paused = true
    stream.once('drain', () => {
      paused = false
      options.onReady?.()
    })
  }

  return {
    ready: () => !paused,
    write(text) {
      if (paused) return false
      const start = now()
      const flushed = stream.write(text)
      options.onWrite?.(now() - start)
      if (flushed === false) pause()
      return true
    },
    writeSync(text) {
      if (typeof stream.fd === 'number') {
        try {
          writeSync(stream.fd, text)
          return
        } catch {
          // A descriptor that is closed, or would block: fall back to the stream.
        }
      }
      stream.write(text)
    },
  }
}
