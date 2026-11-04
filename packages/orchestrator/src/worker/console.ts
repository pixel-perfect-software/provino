// Console capture (T9.4): every console call and every direct stream write becomes a `console`
// event in the packer's queue, so console output keeps its place among the runtime events, tied to
// the task running when it was written. A real `Console` does the formatting (groups, `%s`,
// `table`, `count`), so the text is what Node would have printed.
import { Console } from 'node:console'
import type { RuntimeEventOf, TaskId } from '@provino/types'

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
  /** Install it as a test's `console` (an environment's global, or `globalThis`). */
  readonly console: Console
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
  /** The console method being called, outermost first (`count` calls `log`: it stays `count`). */
  let level: string | null = null

  const record = (stream: 'stdout' | 'stderr', text: string, from: string | null): void => {
    if (text === '') return
    options.emit({
      type: 'console',
      taskId: options.currentTaskId(),
      stream,
      level: from,
      text,
      origin: null,
      t: now(),
    })
  }
  // With `ignoreErrors: false` a Console only calls `write` on its streams (and reads `isTTY` for
  // colour, which a sink without one leaves off).
  const sink = (stream: 'stdout' | 'stderr'): NodeJS.WritableStream => {
    const writable: WritableLike = {
      write(chunk) {
        record(stream, textOf(chunk), level)
        return true
      },
    }
    return writable as NodeJS.WritableStream
  }

  // `ignoreErrors: false`: a sink never throws, and the default would add and remove an `error`
  // listener around every write.
  const captured = new Console({
    stdout: sink('stdout'),
    stderr: sink('stderr'),
    ignoreErrors: false,
  })
  // A Console's methods are its own bound properties, and the ones that print through others
  // (`count`, `table`, `assert`, `trace`, `group`) call them through the instance, so wrapping
  // every own method records the outermost call.
  const methods = captured as unknown as Record<string, unknown>
  for (const name of Object.keys(methods)) {
    const method = methods[name]
    if (typeof method !== 'function') continue
    methods[name] = (...args: unknown[]): unknown => {
      const outer = level
      if (outer === null) level = name
      try {
        return Reflect.apply(method, captured, args)
      } finally {
        level = outer
      }
    }
  }

  return {
    console: captured,
    install(streams, target) {
      const previousConsole = target?.console
      if (target !== undefined) target.console = captured
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

/** Patches one stream's `write` to record instead; returns its flush through the real write, and the undo. */
function patch(
  stream: WritableLike,
  name: 'stdout' | 'stderr',
  record: (stream: 'stdout' | 'stderr', text: string, from: string | null) => void,
): { flush(): Promise<void>; restore(): void } {
  const own = Object.hasOwn(stream, 'write')
  const original = stream.write
  stream.write = function write(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
    const encoding = typeof rest[0] === 'string' ? (rest[0] as BufferEncoding) : undefined
    record(name, textOf(chunk, encoding), null)
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined
    if (callback !== undefined) process.nextTick(callback)
    return true
  }
  return {
    flush: () =>
      new Promise<void>((resolve) => {
        Reflect.apply(original, stream, ['', () => resolve()])
      }),
    restore() {
      if (own) stream.write = original
      else delete (stream as Partial<WritableLike>).write
    },
  }
}

function textOf(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding ?? 'utf8')
}
