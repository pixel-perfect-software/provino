// `--detectOpenHandles` (T9.10): the stacks of the async resources a run left open. It is Jest's
// `collectHandles` (jest-core 30.5.2) rebuilt: `async_hooks` tracks every resource as it is made,
// keeps the stack it was made at, and after the run lists the ones that still hold the process
// open. It only sees what runs in this process, so the run is in band (`pool: 'inline'`), and it
// slows every timer and socket the code creates (about 40-70 times for a `setTimeout`), so it is
// opt-in. What Jest keys on to tell a test's own handle from Node's (its runtime's and circus's
// frames) is here a frame in the project's own files.
import { createHook } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type { OpenHandle } from '@provino/types'

/** Resources that don't keep a process open, or don't last: Jest's list, kept as it is. */
const IGNORED_TYPES: ReadonlySet<string> = new Set([
  'PROMISE',
  'TIMERWRAP',
  'ELDHISTOGRAM',
  'PerformanceObserver',
  'RANDOMBYTESREQUEST',
  'DNSCHANNEL',
  'ZLIB',
  'SIGNREQUEST',
  'TLSWRAP',
  'TCPWRAP',
  'CustomGC',
])

/** How deep a creating stack is captured (Jest's). */
const STACK_LIMIT = 100

/** Provino's own packages: siblings of this one, in a checkout (`packages/`) and installed (`@provino/`). */
const OWN_PACKAGES = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/**
 * What `collectOpenHandles` needs to know about the run.
 * @public
 */
export interface OpenHandleOptions {
  /**
   * The project root directories. A frame in a file under one of them (and not under
   * `node_modules` or Provino's own packages) is the user's code; a resource made from such a
   * frame, or by one that was, is the user's handle. Frames print relative to the first.
   */
  readonly roots: readonly string[]
}

/** One line of a V8 stack: `at fn (file:line:column)` or `at file:line:column`. */
interface Frame {
  readonly text: string
  /** The file as a path (a `file:` URL is converted), `undefined` for `node:` internals and eval. */
  readonly file: string | undefined
  /** The file as the stack wrote it (a `file:` URL stays one): what `shown` replaces. */
  readonly written: string | undefined
  readonly line: number
  readonly column: number
}

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?\s*$/

function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = []
  for (const text of stack.split('\n')) {
    if (!/^\s+at /.test(text)) continue
    const match = FRAME.exec(text)
    let file: string | undefined
    if (match?.[1] !== undefined && !match[1].startsWith('node:')) {
      try {
        file = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1]
      } catch {
        // A `file:` URL that isn't one: not a file the user has.
      }
    }
    frames.push({
      text: text.trim(),
      file,
      written: match?.[1],
      line: Number(match?.[2] ?? 0),
      column: Number(match?.[3] ?? 0),
    })
  }
  return frames
}

/** Whether a file is the project's: under a root, and not a dependency or one of Provino's packages. */
function isUserFile(file: string | undefined, roots: readonly string[]): file is string {
  if (file === undefined || file.includes(`${sep}node_modules${sep}`)) return false
  if (file.startsWith(OWN_PACKAGES + sep)) return false
  return roots.some((root) => file.startsWith(root + sep))
}

let collectGc: (() => void) | undefined

/** `gc()`, which a process without `--expose-gc` can still get at (as Jest does it). */
function runGc(): void {
  if (collectGc === undefined) {
    const global = globalThis as { gc?: () => void }
    if (global.gc === undefined) {
      setFlagsFromString('--expose-gc')
      collectGc = runInNewContext('gc') as () => void
      setFlagsFromString('--no-expose-gc')
    } else {
      collectGc = global.gc
    }
  }
  collectGc()
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Babel's code frame, as Jest prints it with colour off: two lines above and three below the
 * line, the line marked with `>` and a caret under the column.
 * @internal
 */
export function codeFrame(source: string, line: number, column: number): string {
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/)
  const start = Math.max(line - 3, 0)
  const end = Math.min(lines.length, line + 3)
  const width = String(end).length
  return lines
    .slice(start, end)
    .map((text, index) => {
      const number = start + 1 + index
      const gutter = ` ${` ${number}`.slice(-width)} |`
      const shown = text.length > 0 ? ` ${text}` : ''
      if (number !== line) return ` ${gutter}${shown}`
      const spacing = text.slice(0, Math.max(column - 1, 0)).replace(/[^\t]/g, ' ')
      return `>${gutter}${shown}\n ${gutter.replace(/\d/g, ' ')} ${spacing}^`
    })
    .join('\n')
}

/** The frame as Jest prints it: its file relative to the first root, when it is under it. */
function shown(frame: Frame, root: string | undefined): string {
  const { file, written } = frame
  if (file === undefined || written === undefined || root === undefined) return frame.text
  if (!file.startsWith(root + sep)) return frame.text
  return frame.text.replace(written, relative(root, file).split(sep).join('/'))
}

/**
 * Starts tracking async resources, and returns the function that stops it and says what is left
 * open: every resource made by the project's code that is still alive and still holds the event
 * loop (a `Timeout` that is `unref`'d doesn't), one entry per distinct creating stack with the
 * resources' kinds joined by `,`. Call it after the run: it waits a moment for resources that are
 * closing, and for a collection, as Jest does.
 * @public
 */
export function collectOpenHandles(options: OpenHandleOptions): () => Promise<OpenHandle[]> {
  const { roots } = options
  interface Tracked {
    readonly type: string
    readonly frames: readonly Frame[]
    readonly isActive: () => boolean
  }
  const active = new Map<number, Tracked>()
  const hook = createHook({
    destroy(asyncId) {
      active.delete(asyncId)
    },
    init: function initHook(asyncId, type, triggerAsyncId, resource) {
      if (IGNORED_TYPES.has(type)) return
      const previous = Error.stackTraceLimit
      Error.stackTraceLimit = STACK_LIMIT
      const error = new Error(type)
      Error.captureStackTrace(error, initHook)
      Error.stackTraceLimit = previous
      let frames = parseFrames(error.stack ?? '')
      let fromUser = frames.some((frame) => isUserFile(frame.file, roots))
      // Made by something the user's code started (a socket's `data` callback opens a timer): the
      // handle is the user's, and its stack is the one of the resource that started it.
      if (!fromUser) {
        const trigger = active.get(triggerAsyncId)
        if (trigger !== undefined) {
          fromUser = true
          frames = [...trigger.frames]
        }
      }
      if (!fromUser) return
      let isActive = (): boolean => true
      if ('hasRef' in resource && typeof resource.hasRef === 'function') {
        const ref = new WeakRef(resource as { hasRef(): boolean })
        isActive = () => ref.deref()?.hasRef() ?? false
      }
      active.set(asyncId, { type, frames, isActive })
    },
  })
  hook.enable()
  return async () => {
    // Resources queued for destruction are destroyed after their close callbacks run.
    await sleep(0)
    if (active.size > 0) {
      await sleep(30)
      if (active.size > 0) {
        runGc()
        await sleep(0)
      }
    }
    hook.disable()
    const open = [...active.values()].filter((handle) => handle.isActive())
    active.clear()

    // One entry per stack: a timer and the immediate it made can point at the same line.
    const [root] = roots
    const byStack = new Map<string, { readonly types: Set<string>; readonly frames: Frame[] }>()
    for (const { type, frames } of open) {
      const shownFrames = frames.filter((frame) =>
        frame.file === undefined
          ? !frame.text.includes('node:')
          : !frame.file.startsWith(OWN_PACKAGES + sep),
      )
      const keyed = shownFrames.map((frame) => shown(frame, root))
      const key = stripVTControlCharacters(keyed.join('\n'))
      if (keyed.length === 0) continue
      const entry = byStack.get(key) ?? { types: new Set<string>(), frames: shownFrames }
      entry.types.add(type)
      byStack.set(key, entry)
    }
    return [...byStack.values()].map(({ types, frames }): OpenHandle => {
      const top = frames.find((frame) => isUserFile(frame.file, roots))
      let frame: string | undefined
      if (top?.file !== undefined) {
        try {
          frame = codeFrame(readFileSync(top.file, 'utf8'), top.line, top.column)
        } catch {
          // The file is gone or unreadable: the stack still says where.
        }
      }
      return {
        type: [...types].join(','),
        frames: frames.map((entry) => shown(entry, root)),
        ...(frame === undefined ? {} : { codeFrame: frame }),
      }
    })
  }
}
