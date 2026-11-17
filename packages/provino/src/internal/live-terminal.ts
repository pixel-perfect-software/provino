// What a run does to its own process while the `provino` reporter draws a live footer (B26): the
// terminal is put back on every way out (the run's end, a throw, `exit`, a signal nobody else
// handles), the width follows the terminal, and whatever this process writes to its own stdout or
// stderr (a test's direct write or an inline worker's console, in band or `--pool inline`) goes
// above the footer, through the reporter's `passthrough`, instead of over it: each of the two that
// is a terminal (a piped stdout keeps its writes where they were going).
import { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { TextSink } from '@provino/reporters'
import type { LiveTerminal, TerminalStream } from '@provino/reporters/live'

/**
 * The signals whose default action ends the process with the cursor hidden. A handler is added
 * for one only when nothing else listens for it (the bin's own `SIGINT`, `SIGTERM` and `SIGHUP`
 * handlers end the run, which restores the terminal itself), and it re-raises the signal after the
 * restore, so the default action and its exit code are kept.
 * @internal
 */
export const RESTORE_SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP', 'SIGQUIT', 'SIGTERM', 'SIGINT']

/** A stream whose `write` the live region takes over. */
interface PatchableStream {
  write: NodeJS.WritableStream['write']
}

/**
 * What `hookTerminal` touches: the process, by default. A test passes a stand-in.
 * @internal
 */
export interface TerminalHost {
  once(event: 'exit', listener: () => void): unknown
  once(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
  off(event: 'exit', listener: () => void): unknown
  off(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
  listenerCount(event: string): number
  kill(pid: number, signal: NodeJS.Signals): unknown
  readonly pid: number
  readonly stdout: PatchableStream
  readonly stderr: PatchableStream
}

/**
 * Text written as a `Writable`'s chunks or a `write` call's `chunk`, as a string: Node hands a
 * write a string or bytes.
 */
function textOf(chunk: unknown, encoding: unknown, decoder: StringDecoder): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) {
    return typeof encoding === 'string' && encoding !== 'buffer' && Buffer.isEncoding(encoding)
      ? Buffer.from(chunk).toString(encoding)
      : decoder.write(Buffer.from(chunk))
  }
  return String(chunk)
}

/**
 * The stream the pool writes its workers' own stderr to while the footer is drawn: each chunk goes
 * to `sink` (the reporter's `passthrough`). It answers `isTTY`, `columns` and `hasColors()` as
 * `stderr` does, so a decision made from the stream is the one the run would make without the
 * footer, and `end()` does nothing: the region outlives any one writer.
 * @internal
 */
export function streamOver(sink: TextSink, stderr: object): NodeJS.WritableStream {
  const decoder = new StringDecoder('utf8')
  class PassthroughStream extends Writable {
    get isTTY(): unknown {
      return Reflect.get(stderr, 'isTTY')
    }
    get columns(): unknown {
      return Reflect.get(stderr, 'columns')
    }
    hasColors(...args: unknown[]): boolean {
      const hasColors: unknown = Reflect.get(stderr, 'hasColors')
      return typeof hasColors === 'function' && Reflect.apply(hasColors, stderr, args) === true
    }
    override end(..._args: unknown[]): this {
      return this
    }
  }
  return new PassthroughStream({
    decodeStrings: false,
    write(chunk: unknown, encoding, done) {
      const text = textOf(chunk, encoding, decoder)
      if (text !== '') void sink.write(text)
      done()
    },
  })
}

/**
 * The stream the `provino` reporter writes to: `stderr`'s own methods, taken now, so the reporter
 * keeps writing to the terminal while `hookTerminal` routes the process's other writes to stderr
 * through the reporter. `fd` and `writableLength` are read when asked (the synchronous restore).
 * @internal
 */
export function pinnedStream(stderr: NodeJS.WritableStream): TerminalStream {
  const write = stderr.write.bind(stderr)
  const once = stderr.once.bind(stderr)
  const off = stderr.off.bind(stderr)
  return {
    write: (chunk) => write(chunk),
    once: (event, listener) => once(event, listener),
    off: (event, listener) => off(event, listener),
    get fd() {
      const fd: unknown = Reflect.get(stderr, 'fd')
      return typeof fd === 'number' ? fd : undefined
    },
    get writableLength() {
      const length: unknown = Reflect.get(stderr, 'writableLength')
      return typeof length === 'number' ? length : undefined
    },
  }
}

/**
 * A text sink that writes with `stream`'s own `write`, taken now: a document reporter keeps
 * writing to the real stdout while the region routes the process's other stdout writes.
 * @internal
 */
export function pinnedSink(stream: TextSink): TextSink {
  const write = stream.write.bind(stream)
  return { write: (chunk) => write(chunk) }
}

/** Takes over `stream.write` so every write goes to `sink`; returns the call that puts it back exactly. */
function routeWrites(stream: PatchableStream, sink: TextSink): () => void {
  const hadOwn = Object.hasOwn(stream, 'write')
  const own = hadOwn ? stream.write : undefined
  const decoder = new StringDecoder('utf8')
  const routed: PatchableStream['write'] = (
    chunk: unknown,
    encodingOrDone?: unknown,
    done?: unknown,
  ): boolean => {
    // Only an append to the reporter's queue: the frame writes it.
    void sink.write(textOf(chunk, encodingOrDone, decoder))
    const callback = typeof encodingOrDone === 'function' ? encodingOrDone : done
    if (typeof callback === 'function')
      process.nextTick(() => Reflect.apply(callback, undefined, []))
    return true
  }
  stream.write = routed
  return () => {
    if (own !== undefined) stream.write = own
    else Reflect.deleteProperty(stream, 'write')
  }
}

/**
 * Hooks the live terminal into the process for the run's life: the restore on `exit` (it writes
 * synchronously, so it lands on a `process.exit`: `--forceExit`, the force signal), on a signal no
 * one else handles (then the signal again, so its default action and exit code stay), the width on
 * `resize`, and the process's own stdout and stderr writes routed through `passthrough`. Returns
 * the one call that undoes all of it and restores the terminal; it is safe to call twice.
 * @internal
 */
export function hookTerminal(
  terminal: LiveTerminal,
  stderr: NodeJS.WritableStream,
  host: TerminalHost = process,
): () => void {
  let done = false
  const restore = (): void => terminal.restore()
  const resize = (): void => {
    const columns: unknown = Reflect.get(stderr, 'columns')
    if (typeof columns === 'number' && columns >= 1) terminal.resize(Math.floor(columns))
  }
  const signals = RESTORE_SIGNALS.filter((signal) => host.listenerCount(signal) === 0)
  const onSignal = (signal: NodeJS.Signals): void => {
    dispose()
    host.kill(host.pid, signal)
  }
  host.once('exit', restore)
  for (const signal of signals) host.once(signal, onSignal)
  stderr.on('resize', resize)
  // Only a stream that is a terminal can draw over the footer; a piped stdout keeps its writes.
  const unroute = [host.stdout, host.stderr]
    .filter((stream) => Reflect.get(stream, 'isTTY') === true)
    .map((stream) => routeWrites(stream, terminal.passthrough))
  function dispose(): void {
    if (done) return
    done = true
    for (const back of unroute) back()
    host.off('exit', restore)
    for (const signal of signals) host.off(signal, onSignal)
    stderr.off('resize', resize)
    // After `run:end` this writes nothing; after a run that threw, it erases the footer, shows the
    // cursor and prints what was waiting for a frame.
    terminal.restore()
  }
  return dispose
}
