// `--detectOpenHandles` (T9.10): the stacks of the async resources a run left open. It is Jest's
// `collectHandles` (jest-core 30.5.2) rebuilt: `async_hooks` tracks every resource as it is made,
// keeps the stack it was made at, and after the run lists the ones that still hold the process
// open. It only sees what runs in this process, so the run is in band (`pool: 'inline'`), and it
// slows every timer and socket the code creates (about 40-70 times for a `setTimeout`), so it is
// opt-in. What Jest keys on to tell a test's own handle from Node's (its runtime's and circus's
// frames) is here a frame in the project's own files.
import { createHook, type HookCallbacks } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
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
const OWN_PREFIX = dirname(dirname(dirname(fileURLToPath(import.meta.url)))) + sep

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

/**
 * What tracks the async resources of a run.
 * @public
 */
export interface OpenHandleTracker {
  /**
   * Says what is left open: it waits a moment for resources that are closing, and for a
   * collection, as Jest does, then stops tracking. Call it after the run, once.
   */
  collect(): Promise<OpenHandle[]>
  /** Stops tracking and forgets what was tracked, with no wait and no result: for a run that failed. */
  dispose(): void
}

/** One line of a V8 stack, from the structured call site that made it. */
interface Frame {
  /** `at fn (file:line:column)`, as the stack writes it. */
  readonly text: string
  /** The file as a path (a `file:` URL is converted), `undefined` for `node:` internals and eval. */
  readonly file: string | undefined
  /** The file as the stack wrote it (a `file:` URL stays one): what `shown` replaces. */
  readonly written: string | undefined
  readonly line: number
  readonly column: number
}

/** A call site's file as a path: `undefined` for `node:` internals, eval and anything with no file. */
function fileOf(written: string | null): string | undefined {
  if (written === null || written.startsWith('node:')) return undefined
  if (!written.startsWith('file:')) return written
  try {
    return fileURLToPath(written)
  } catch {
    // A `file:` URL that isn't one: not a file the user has.
    return undefined
  }
}

function frameOf(site: NodeJS.CallSite): Frame {
  const written = site.getFileName()
  return {
    text: `at ${String(site)}`,
    file: fileOf(written),
    written: written ?? undefined,
    line: site.getLineNumber() ?? 0,
    column: site.getColumnNumber() ?? 0,
  }
}

/** Whether a file is one of Provino's own packages. */
function isOwnFile(file: string): boolean {
  return file.startsWith(OWN_PREFIX)
}

/** Whether a file is the project's: under a root, and not a dependency or one of Provino's packages. */
function isUserFile(file: string | undefined, roots: readonly string[]): file is string {
  if (file === undefined || file.includes(`${sep}node_modules${sep}`) || isOwnFile(file)) {
    return false
  }
  return roots.some((root) => file.startsWith(root + sep))
}

/**
 * The stack above `above` as structured call sites, innermost first. Reading them costs far less
 * than the stack's text, which only a kept resource needs.
 */
function callSites(above: (...args: never[]) => unknown): NodeJS.CallSite[] {
  const limit = Error.stackTraceLimit
  const prepare = Error.prepareStackTrace
  Error.stackTraceLimit = STACK_LIMIT
  Error.prepareStackTrace = (_error, sites) => sites
  try {
    const holder: { stack?: NodeJS.CallSite[] } = {}
    Error.captureStackTrace(holder, above)
    // The stack is formatted when it is first read, so it is read while the override is on.
    return holder.stack ?? []
  } finally {
    Error.stackTraceLimit = limit
    Error.prepareStackTrace = prepare
  }
}

let collectGc: (() => void) | undefined

/** `gc()`, which a process without `--expose-gc` can still get at (as Jest does it). */
function runGc(): void {
  if (collectGc === undefined) {
    const global = globalThis as { gc?: () => void }
    if (global.gc === undefined) {
      // Read here, where a collection is due, not by every run that merely loads this module.
      const { setFlagsFromString } = process.getBuiltinModule('node:v8')
      const { runInNewContext } = process.getBuiltinModule('node:vm')
      setFlagsFromString('--expose-gc')
      collectGc = runInNewContext('gc') as () => void
      setFlagsFromString('--no-expose-gc')
    } else {
      collectGc = global.gc
    }
  }
  collectGc()
}

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

/** Whether a frame is worth showing: Node's own and Provino's are left out. */
function isShownFrame(frame: Frame): boolean {
  return frame.file === undefined ? !frame.text.includes('node:') : !isOwnFile(frame.file)
}

/**
 * Starts tracking async resources, and returns what stops it and says what is left open: every
 * resource made by the project's code that is still alive and still holds the event loop (a
 * `Timeout` that is `unref`'d doesn't), one entry per distinct creating stack with the resources'
 * kinds joined by `,`.
 * @public
 */
export function collectOpenHandles(options: OpenHandleOptions): OpenHandleTracker {
  const { roots } = options
  interface Tracked {
    readonly type: string
    readonly frames: readonly Frame[]
    readonly isActive: () => boolean
  }
  const active = new Map<number, Tracked>()
  const callbacks: HookCallbacks & { readonly trackPromises: boolean } = {
    // No hook for a promise: `PROMISE` is ignored below anyway, and tracking them makes every
    // `await` several times dearer. (Node before 22.15's option ignores this and skips them below.)
    trackPromises: false,
    destroy(asyncId) {
      active.delete(asyncId)
    },
    init: function initHook(asyncId, type, triggerAsyncId, resource) {
      if (IGNORED_TYPES.has(type)) return
      const sites = callSites(initHook)
      let frames: readonly Frame[]
      if (sites.some((site) => isUserFile(fileOf(site.getFileName()), roots))) {
        frames = sites.map(frameOf)
      } else {
        // Made by something the user's code started (a socket's `data` callback opens a timer): the
        // handle is the user's, and its stack is the one of the resource that started it.
        const trigger = active.get(triggerAsyncId)
        if (trigger === undefined) return
        frames = trigger.frames
      }
      let isActive = (): boolean => true
      if ('hasRef' in resource && typeof resource.hasRef === 'function') {
        const ref = new WeakRef(resource as { hasRef(): boolean })
        isActive = () => ref.deref()?.hasRef() ?? false
      }
      active.set(asyncId, { type, frames, isActive })
    },
  }
  const hook = createHook(callbacks)
  hook.enable()
  return {
    async collect() {
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
      const byStack = new Map<
        string,
        { readonly types: Set<string>; readonly frames: readonly Frame[]; readonly lines: string[] }
      >()
      for (const { type, frames } of open) {
        const shownFrames = frames.filter(isShownFrame)
        if (shownFrames.length === 0) continue
        const lines = shownFrames.map((frame) => shown(frame, root))
        const key = lines.join('\n')
        const entry = byStack.get(key) ?? { types: new Set<string>(), frames: shownFrames, lines }
        entry.types.add(type)
        byStack.set(key, entry)
      }
      return [...byStack.values()].map(({ types, frames, lines }): OpenHandle => {
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
          frames: lines,
          ...(frame === undefined ? {} : { codeFrame: frame }),
        }
      })
    },
    dispose() {
      hook.disable()
      active.clear()
    },
  }
}
