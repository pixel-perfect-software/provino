// Console capture (T9.4): every console call and every direct stream write becomes a `console`
// event in the packer's queue, so console output keeps its place among the runtime events, tied to
// the task running when it was written. A real `Console` does the formatting (groups, `%s`,
// `table`, `count`), so the text is what Node would have printed.
import { Console } from 'node:console'
import { StringDecoder } from 'node:string_decoder'
import type { RuntimeEventOf, TaskId } from '@provino/types'
import { flushStream } from './stdio.ts'

/**
 * The part of a writable stream the capture patches: `process.stdout`, `process.stderr`, or a
 * stand-in.
 * @public
 */
export interface WritableLike {
  write(chunk: string | Uint8Array, ...rest: unknown[]): boolean
}

/**
 * Options for `createConsoleCapture`.
 * @public
 */
export interface ConsoleCaptureOptions {
  readonly emit: (event: RuntimeEventOf<'console'>) => void
  /** The task running now (the current-test lookup), or `null` outside any task. */
  readonly currentTaskId: () => TaskId | null
  /** The event clock. Default `performance.now`, core's clock. */
  readonly now?: () => number
  /**
   * Whether a console call keeps its call site as the event's `origin` (`orchestrator.consoleOrigin`
   * is `stack`). Read at each call, since the policy arrives with the worker's init. Default: no.
   */
  readonly origin?: () => boolean
}

/**
 * What `install` patched, and how to undo it.
 * @public
 */
export interface InstalledCapture {
  /** Writes `''` through each stream's own `write` and waits for its callback (Vitest's flush). */
  flush(): Promise<void>
  restore(): void
}

/**
 * A console whose output becomes events, plus stream patching.
 * @public
 */
export interface ConsoleCapture {
  /**
   * Install it as a test's `console` (an environment's global, or `globalThis`). It stays the same
   * object across `reset`.
   */
  readonly console: Console
  /** Starts a fresh console behind `console`: no open group, count or timer carries over. */
  reset(): void
  /**
   * Replaces `target.console` with the capture's console (when `target` is given) and patches
   * `write` on the given streams, so direct writes become `level: null` events.
   */
  install(
    streams: { readonly stdout: WritableLike; readonly stderr: WritableLike },
    target?: { console: Console },
  ): InstalledCapture
}

/**
 * Creates a console capture that sends each write to `emit`.
 * @public
 */
export function createConsoleCapture(options: ConsoleCaptureOptions): ConsoleCapture {
  const now = options.now ?? (() => performance.now())
  /** The console method being called through the capture's console, innermost call first. */
  let level: string | null = null

  /** The call site of the console method being called, kept until its text is recorded. */
  let site: string | null = null

  const record = (stream: 'stdout' | 'stderr', text: string, from: string | null): void => {
    if (text === '') return
    options.emit({
      type: 'console',
      taskId: options.currentTaskId(),
      stream,
      level: from,
      text,
      origin: from === null ? null : site,
      t: now(),
    })
  }
  // With `ignoreErrors: false` a Console only calls `write` on its streams (and reads `isTTY` for
  // colour, which a sink without one leaves off).
  const sink = (stream: 'stdout' | 'stderr'): NodeJS.WritableStream => {
    const writable: WritableLike = {
      write(chunk) {
        record(stream, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(), level)
        return true
      },
    }
    return writable as NodeJS.WritableStream
  }
  // `ignoreErrors: false`: a sink never throws, and the default would add and remove an `error`
  // listener around every write.
  const fresh = (): Console =>
    new Console({ stdout: sink('stdout'), stderr: sink('stderr'), ignoreErrors: false })

  /** A Console's methods are its own bound properties; seen as a record of them. */
  type Methods = Record<string, (...args: unknown[]) => unknown>
  let inner = fresh() as unknown as Methods
  /** Whether a method ran since the last reset: a file that never logs keeps its console. */
  let used = false
  // The console handed out is a stable front whose methods call the current inner Console. The
  // inner methods that print through others (`count`, `table`, `assert`, `trace`, `group`) call
  // the inner instance's own, unwrapped ones, so they keep the front method's level. A call that
  // comes back through the front (an `inspect.custom` that logs) is recorded under its own.
  const front = Object.create(Console.prototype) as Console
  const methods = front as unknown as Methods
  for (const [name, method] of Object.entries(inner)) {
    if (typeof method !== 'function') continue
    const call = (...args: unknown[]): unknown => {
      const outer = level
      const outerSite = site
      level = name
      used = true
      // Only the outermost call (the user's) gives the site: a method that prints through
      // others keeps it.
      if (outer === null && options.origin?.() === true)
        site = callSite(call, name === 'warn' || name === 'error')
      try {
        return Reflect.apply(inner[name] as Methods[string], inner, args)
      } finally {
        level = outer
        site = outerSite
      }
    }
    methods[name] = call
  }

  return {
    console: front,
    reset() {
      if (!used) return
      inner = fresh() as unknown as Methods
      used = false
    },
    install(streams, target) {
      const previousConsole = target?.console
      if (target !== undefined) target.console = front
      const patched = [
        patch(streams.stdout, 'stdout', record),
        patch(streams.stderr, 'stderr', record),
      ]
      return {
        flush: async () => {
          await Promise.all(patched.map((stream) => stream.flush()))
        },
        restore() {
          for (const stream of patched) stream.restore()
          if (target !== undefined && previousConsole !== undefined)
            target.console = previousConsole
        },
      }
    },
  }
}

/**
 * Patches one stream's `write` to record instead; returns its flush through the real write, and
 * the undo. Text is decoded as the terminal would see the bytes: a string chunk is encoded with
 * its encoding, a byte chunk ignores one, and one UTF-8 decoder per stream carries a character
 * split across writes.
 */
function patch(
  stream: WritableLike,
  name: 'stdout' | 'stderr',
  record: (stream: 'stdout' | 'stderr', text: string, from: string | null) => void,
): { flush(): Promise<void>; restore(): void } {
  const own = Object.hasOwn(stream, 'write')
  const original = stream.write
  const decoder = new StringDecoder('utf8')
  stream.write = function write(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
    const encoding = typeof rest[0] === 'string' && Buffer.isEncoding(rest[0]) ? rest[0] : 'utf8'
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    record(name, decoder.write(bytes), null)
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined
    if (callback !== undefined) process.nextTick(callback)
    return true
  }
  return {
    flush: () => flushStream(stream as Parameters<typeof flushStream>[0], original),
    restore() {
      if (own) stream.write = original
      else delete (stream as Partial<WritableLike>).write
    },
  }
}

/**
 * The call site of a console method as Jest's `BufferedConsole` keeps it: for `log` and the other
 * quiet kinds the one `at …` line of the call (Jest prints only the first frame of those); for
 * `warn` and `error` (`all`), whose text Jest prints with a code frame and every frame outside
 * Jest, the whole stack (V8's default depth of 10, as Jest's `ErrorWithStack` captures). Frames
 * are named as the worker's stack formatter names them (`at Object.log (file:4:11)` under the Jest
 * dialect: DV88).
 * `below` is the method's own front function, whose frame and those above it are left out. `null`
 * when the frame can't be read: reading `.stack` runs the user's `Error.prepareStackTrace`, which
 * may throw or return something that is no string (`callsites` and `depd` do).
 */
function callSite(below: (...args: never[]) => unknown, all: boolean): string | null {
  const holder: { stack?: unknown } = {}
  const limit = Error.stackTraceLimit
  let stack: unknown
  try {
    Error.stackTraceLimit = all ? Math.max(10, limit) : 1
    Error.captureStackTrace(holder, below)
    stack = holder.stack
  } catch {
    return null
  } finally {
    Error.stackTraceLimit = limit
  }
  if (typeof stack !== 'string') return null
  const lines = stack.split('\n').filter((line) => line.trimStart().startsWith('at '))
  const frame = lines[0]
  if (frame === undefined) return null
  // The frame as V8 (and the worker's source-mapped formatter, DV88) names it, as Jest keeps it.
  const first = frame.trim()
  const place = first
    .slice(first.indexOf(' (') === -1 ? 3 : first.indexOf(' (') + 2)
    .replace(/\)$/, '')
  if (!/:\d+:\d+$/.test(place)) return null
  return all ? [first, ...lines.slice(1)].join('\n') : first
}
