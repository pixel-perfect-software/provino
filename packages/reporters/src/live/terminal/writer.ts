// The one place the renderer writes to the terminal (performance rule 3). Each frame is one
// write, timed; a write that returns `false` (a pipe whose reader is slow) pauses frames until the
// stream drains, and text that must not be lost (`writeAlways`) waits in a queue meanwhile. A
// stream that errors or closes while paused ends the writer: nothing more is written, nothing
// throws. The restore on `exit` is synchronous, to the stream's file descriptor, because a `write`
// queued on the way out may never run; it loops on partial writes and never passes data the stream
// still holds.

import { writeSync as fsWriteSync } from 'node:fs'

/**
 * What the renderer writes to: a `tty.WriteStream`, a pipe, a test's buffer.
 * @beta
 */
export interface TerminalStream {
  /** A `false` return means the stream's buffer is full: wait for `drain`. */
  write(chunk: string | Uint8Array): unknown
  once?(event: 'drain' | 'error' | 'close', listener: (argument?: unknown) => void): unknown
  off?(event: 'drain' | 'error' | 'close', listener: (argument?: unknown) => void): unknown
  /** Bytes the stream holds that have not reached the descriptor: a write to the descriptor must not pass them. */
  readonly writableLength?: number | undefined
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
  /** Called with the error a stream emitted while it was full (EPIPE): the writer is over. */
  readonly onError?: (cause: unknown) => void
  /** `fs.writeSync(fd, data, offset)`: returns the bytes written. A test passes its own. */
  readonly writeFd?: (fd: number, data: Uint8Array, offset: number) => number
}

/**
 * Writes frames, timed, pausing while the stream is full.
 * @beta
 */
export interface TimedWriter {
  /** Whether a frame may be written: false while the stream has not drained, or once it failed or closed. */
  ready(): boolean
  /** Writes one frame, if `ready` and nothing is queued; returns whether it did. */
  write(text: string): boolean
  /** Writes `text`, or keeps it until the stream drains, in order. Never drops it (a closed stream aside). */
  writeAlways(text: string): void
  /**
   * Writes `text` now, synchronously where the stream has a descriptor and holds nothing; what the
   * descriptor does not take, and everything when the stream has buffered data, goes through the
   * stream in order. For the restore.
   */
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
  const syncWrite = options.writeFd ?? ((fd, data, offset) => fsWriteSync(fd, data, offset))
  let paused = false
  let done = false
  let release: (() => void) | undefined
  const queue: (string | Uint8Array)[] = []

  function flush(): void {
    while (queue.length > 0 && !paused && !done) {
      if (stream.write(queue.shift() as string | Uint8Array) === false) pause()
    }
  }

  function pause(): void {
    // Without `once` there is nothing to wait for, so the stream is taken as ready.
    if (stream.once === undefined || paused) return
    paused = true
    const onDrain = (): void => {
      release?.()
      paused = false
      flush()
      if (!paused && !done) options.onReady?.()
    }
    const onError = (cause?: unknown): void => {
      release?.()
      paused = false
      done = true
      queue.length = 0
      options.onError?.(cause)
    }
    const onClose = (): void => {
      release?.()
      paused = false
      done = true
      queue.length = 0
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
    stream.once('close', onClose)
    release = () => {
      stream.off?.('drain', onDrain)
      stream.off?.('error', onError)
      stream.off?.('close', onClose)
      release = undefined
    }
  }

  /** Writes or queues one chunk. Only a frame is timed: the scheduler's backoff reads frame writes. */
  function send(chunk: string | Uint8Array, timed = false): void {
    if (done) return
    if (paused || queue.length > 0) {
      queue.push(chunk)
      return
    }
    const start = timed ? now() : 0
    const flushed = stream.write(chunk)
    if (timed) options.onWrite?.(now() - start)
    if (flushed === false) pause()
  }

  return {
    ready: () => !paused && !done,
    write(text) {
      if (paused || done || queue.length > 0) return false
      send(text, true)
      return true
    },
    writeAlways: (text) => send(text),
    writeSync(text) {
      if (done) return
      const fd = stream.fd
      if (typeof fd === 'number' && !paused && queue.length === 0 && !stream.writableLength) {
        const bytes = Buffer.from(text)
        let offset = 0
        try {
          while (offset < bytes.length) {
            const written = syncWrite(fd, bytes, offset)
            if (written <= 0) break
            offset += written
          }
        } catch {
          // A descriptor that is closed, or would block: the rest goes through the stream.
        }
        if (offset >= bytes.length) return
        send(offset === 0 ? text : bytes.subarray(offset))
        return
      }
      send(text)
    },
  }
}
