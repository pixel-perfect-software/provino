// The timers a file sets on a Jest window environment die with its window, as in Jest.
//
// There the test's global is the jsdom window, its `setTimeout` and `setInterval` are jsdom's own,
// and jest-environment-jsdom's teardown calls `window.close()`, which cancels every one still
// pending (the window has no `setImmediate`). Here the window is populated onto the worker's
// global, whose timers are Node's, so a timer a file's last test left (an effect's cleanup after
// unmount, a state update from a timer, React's scheduler) would fire after the restore deleted
// `window`, with `ReferenceError: window is not defined`.
//
// One wrapper per timer function is put on the global once per worker, when the Jest dialect's
// worker boots (`jestModuleScope`), before any test file loads anything, whatever the project's
// default environment: a shared package that captures `setTimeout` as it loads, in a node file or
// a window file, captures the wrapper, the same one in every file, so the timers are no per-file
// global (D129) and nothing is evaluated again for them. While a window file runs (`track`), the
// wrapper notes each timer it hands out, with the stack that set it; when the window closes, the
// file's timers still pending are cancelled.
//
// **Which timers are the file's** is read from that stack, outward from where the timer was set,
// only when it is asked (a timer still pending at the end, or one whose callback sets another):
// - a frame in a module the file's registry evaluated (the test file, its modules, the externals
//   evaluated per file) makes it the file's;
// - a frame in Provino's own code (the coordinator's, in band; the loader's, whose parser keeps
//   timers of its own) makes it not the file's, and it runs as it would have;
// - a frame of a shared package (a `node_modules` file Node loaded once for the worker, D127)
//   whose source holds the callback makes that package the timer's owner, and the timer the file's;
// - the frame of the wrapper around a noted timer's callback (below) gives that timer's verdict.
// A stack with none of these (no frame read) is not the file's.
//
// **A timer set inside the callback of one of the file's is the file's too.** A loop that
// schedules its next step from its own callback (React's scheduler: `performWorkUntilDeadline`
// calls `setImmediate(performWorkUntilDeadline)` while work remains) sets each later timer with
// only its own frames on the stack, and the wrapper's below them. So each noted timer's callback
// is wrapped, by a function named `provinoWindowTimerCallback` (the bundle inlines other Provino
// code into this file, so the frame is known by its name, not its path), which marks that timer as
// running for the callback's synchronous part; a timer set then reads the running timer's verdict
// as it is set. Its own walk still comes first, so the frames between it and the wrapper decide
// when they can: the file's code claims what it sets there (with the shared package that called
// the timer as owner), and Provino's code (the loader's parser, from a lazy `require`) keeps its
// own. A walk that reaches the wrapper, or is cut short by `Error.stackTraceLimit` before it,
// takes the running timer's verdict, owned by the first shared frame it passed, else by that
// timer's owner. The running timer's verdict is read once (the file's modules read again only when
// it is not the file's, since a module may have loaded since the last read), and kept: the frames
// don't change. A timer keeps only its parent's verdict, never the parent, so a loop holds no chain
// of its slices. An interval's runs are the one timer under its one handle, noted once. A promise
// continuation inside a callback is a microtask that runs after the synchronous part, so a timer it
// sets is read from its own stack, as one set outside any callback is.
//
// **A shared package that owned one is evaluated per file from then on.** In Jest every module is
// evaluated again in each file, so cancelling a window's timers loses nothing a later file needs.
// Here a shared package keeps its state across files: a scheduler's "loop running" flag that only
// its own timer's callback clears would stay set once that timer is cancelled, and the next file's
// work would never run. Letting the timer run instead runs the closed file's work without its
// window. So the timer is cancelled, as in Jest, and the package is reported in the teardown
// report's `perFileModules`, so the worker gives every later file its own copy, as Jest does: the
// stale copy's flag is no later file's. A callback a file hands a shared package (a helper that
// calls the timer it kept from a node file) is not the package's own, so nothing is reported.
//
// Costs (`local`, Node 24, `Error.stackTraceLimit` as the process has it). While a window file
// runs, every timer's stack is captured: a `setTimeout` and `clearTimeout` cost about 1.7 µs more
// than Node's own. The first timer set inside a callback also reads the running timer's verdict,
// so each slice of a self-rescheduling loop, a new parent every time, costs about 3.5 µs. The walk
// stops at the first frame that decides. Outside a window file the wrapper passes `arguments`
// through and allocates nothing: within the noise of Node's own (under 10 ns).
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** The per-worker wrappers: `track` at a window file's setup. */
export interface WindowTimers {
  /**
   * Starts noting the timers set through the global, for the window file being set up. Returns
   * the call that cancels the file's timers still pending and stops noting (once; a later call
   * does nothing): it returns the shared modules that owned a cancelled timer.
   */
  track(): () => readonly string[]
}

/** What `installWindowTimers` is told by the worker. */
export interface WindowTimersOptions {
  /**
   * The paths of the modules the running file's registry evaluated (`FileRegistry.loadedModules`),
   * read when its window closes. Absent (a caller with no registry), or when it throws: every
   * noted timer is the file's.
   */
  readonly fileModules?: () => Iterable<string>
}

type Callback = (...args: unknown[]) => unknown
type Clear = (handle: unknown) => void

/** Where a noted timer was set: what it calls, its stack, and the callback it was set inside. */
interface Origin {
  readonly callback: object
  /** Holds the captured stack, read only when a verdict is needed. */
  readonly site: { stack?: unknown }
  /**
   * The verdict of the noted timer whose callback was running (its synchronous part) when this
   * one was set, read then; `undefined` when none of this file's was.
   */
  readonly within: Verdict | undefined
  /** Whose it is, once read (the frames it was set from don't change). */
  verdict: Verdict | undefined
}

/** A timer noted while a window file ran: how to cancel it, and where it was set. */
interface Noted {
  readonly clear: Clear
  readonly origin: Origin
}

/** What the walk reads of a callback, once per callback per file. */
interface CallbackFacts {
  readonly text: string
  /** A bound or native callback has no source to look for. */
  readonly readable: boolean
  /** Whether each shared file's source holds the callback, by path. */
  readonly holds: Map<string, boolean>
}

/** A frame's file as the walk reads it: its path, and whose code it is. */
interface FileFacts {
  readonly path: string
  readonly kind: 'provino' | 'shared' | 'other'
}

/** One window file's noting: its pending timers by handle, and what was read for them. */
interface Tracking {
  readonly notes: Map<unknown, Noted>
  /** Each frame's file by the name V8 gives it (`null`: not on disk). */
  readonly files: Map<string, FileFacts | null>
  readonly sources: Map<string, string | null>
  readonly callbacks: WeakMap<object, CallbackFacts>
  /** The file's modules as last read for a running callback (`undefined` before the first). */
  own: ReadonlySet<string> | undefined
}

/** Whose a pending timer is: the file's (with the shared module that owned it, if one did). */
type Verdict =
  | { readonly files: false }
  | { readonly files: true; readonly owner?: string | undefined }

interface Pair {
  readonly set: string
  readonly clear: string
}

const PAIRS: readonly Pair[] = [
  { set: 'setTimeout', clear: 'clearTimeout' },
  { set: 'setInterval', clear: 'clearInterval' },
  { set: 'setImmediate', clear: 'clearImmediate' },
]

interface Installed {
  readonly timers: WindowTimers
  readonly state: { fileModules: (() => Iterable<string>) | undefined }
}

/** The wrappers already on a global: installing twice would wrap the wrappers. */
const installed = new WeakMap<object, Installed>()

function functionOn(global: Record<string, unknown>, key: string): Callback | undefined {
  const value = global[key]
  return typeof value === 'function' ? (value as Callback) : undefined
}

/**
 * Puts the wrappers on `global` (once per global; a second call returns the first's, taking its
 * `fileModules` when the first had none), keeping each original's name and `util.promisify.custom`
 * (the promise form is not noted: Jest's window has none).
 */
export function installWindowTimers(
  global: object = globalThis,
  options: WindowTimersOptions = {},
): WindowTimers {
  const known = installed.get(global)
  if (known !== undefined) {
    if (known.state.fileModules === undefined && options.fileModules !== undefined) {
      known.state.fileModules = options.fileModules
    }
    return known.timers
  }
  const target = global as Record<string, unknown>
  const state: Installed['state'] = { fileModules: options.fileModules }
  // The window file being run; `null` outside one.
  let noting: Tracking | null = null
  // While a noted timer's callback runs (its synchronous part): the file it was noted for, and
  // where it was set. A timer set then is read against that timer's verdict (`within`).
  let runningFor: Tracking | null = null
  let runningOrigin: Origin | null = null

  /**
   * The verdict of the noted timer whose callback is running, read once with the modules the file
   * has loaded so far: the frames it was set from had run, so their modules are among them. The
   * modules are read once per file, and again only when the verdict is "not the file's", since one
   * of its frames may be in a module loaded after the last read. A shared owner is a frame before
   * any of the file's, so a stale read can't change a verdict that is the file's.
   */
  const verdictWithin = (origin: Origin, tracking: Tracking): Verdict => {
    if (origin.verdict !== undefined) return origin.verdict
    let own = tracking.own === undefined ? fileModulesOf(state.fileModules) : tracking.own
    if (own === null) return FILES
    let verdict = verdictOf(origin, own, tracking)
    if (!verdict.files && tracking.own !== undefined) {
      own = fileModulesOf(state.fileModules)
      if (own === null) return FILES
      verdict = verdictOf(origin, own, tracking)
    }
    tracking.own = own
    origin.verdict = verdict
    return verdict
  }

  for (const { set, clear } of PAIRS) {
    const original = functionOn(target, set)
    const originalClear = functionOn(target, clear) as Clear | undefined
    if (original === undefined || originalClear === undefined) continue
    const once = set !== 'setInterval'
    const wrapped = {
      [set](this: unknown, callback: unknown): unknown {
        const tracking = noting
        if (tracking === null || typeof callback !== 'function') {
          // biome-ignore lint/complexity/noArguments: the call goes through as it came, with no array built for it, on every timer outside a window file
          return Reflect.apply(original, this, arguments)
        }
        const within =
          runningFor === tracking && runningOrigin !== null
            ? verdictWithin(runningOrigin, tracking)
            : undefined
        const origin: Origin = { callback, site: {}, within, verdict: undefined }
        Error.captureStackTrace(origin.site, wrapped)
        const { notes } = tracking
        // biome-ignore lint/complexity/noArguments: the parameter list stays one, for the path above
        const args: unknown[] = Array.prototype.slice.call(arguments)
        let handle: unknown
        // An interval's repeats are the one timer under its one handle: each run is the same note.
        // The name is how a stack walk knows this frame (`WRAPPER_NAME`): the bundle inlines other
        // Provino code into this file, so its path can't tell it apart.
        args[0] = function provinoWindowTimerCallback(this: unknown, ...given: unknown[]): unknown {
          if (once) notes.delete(handle)
          const previousFor = runningFor
          const previousOrigin = runningOrigin
          runningFor = tracking
          runningOrigin = origin
          try {
            return Reflect.apply(callback as Callback, this, given)
          } finally {
            runningFor = previousFor
            runningOrigin = previousOrigin
          }
        }
        handle = Reflect.apply(original, this, args)
        notes.set(handle, { clear: originalClear, origin })
        return handle
      },
    }[set] as Callback
    const wrappedClear = {
      [clear](this: unknown, handle: unknown): void {
        noting?.notes.delete(handle)
        originalClear.call(this, handle)
      },
    }[clear] as Clear
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom]
    if (custom !== undefined) {
      Object.defineProperty(wrapped, promisify.custom, {
        value: custom,
        writable: false,
        enumerable: false,
        configurable: true,
      })
    }
    // Node's timer globals are writable data properties, so an assignment keeps their attributes.
    target[set] = wrapped
    target[clear] = wrappedClear
  }

  const timers: WindowTimers = {
    track() {
      const tracking: Tracking = {
        notes: new Map(),
        files: new Map(),
        sources: new Map(),
        callbacks: new WeakMap(),
        own: undefined,
      }
      noting = tracking
      let stopped = false
      return () => {
        if (stopped) return NONE
        stopped = true
        if (noting === tracking) noting = null
        const owners = cancelPending(tracking)
        // A timer left running (Provino's own) keeps this tracking through its wrapper's closure:
        // drop what was read for the file, the shared packages' sources above all.
        tracking.notes.clear()
        tracking.files.clear()
        tracking.sources.clear()
        tracking.own = undefined
        return owners
      }
    },
  }
  /** Cancels the file's timers still pending, and returns the shared modules that owned one. */
  const cancelPending = (tracking: Tracking): readonly string[] => {
    if (tracking.notes.size === 0) return NONE
    const own = fileModulesOf(state.fileModules)
    const owners = new Set<string>()
    for (const [handle, noted] of tracking.notes) {
      const { origin } = noted
      let verdict = FILES
      if (own !== null) {
        verdict = origin.verdict ?? verdictOf(origin, own, tracking)
        origin.verdict = verdict
      }
      if (!verdict.files) continue
      noted.clear(handle)
      if (verdict.owner !== undefined) owners.add(verdict.owner)
    }
    return owners.size === 0 ? NONE : [...owners]
  }

  installed.set(global, { timers, state })
  return timers
}

const NONE: readonly string[] = []
const FILES: Verdict = { files: true }
const NOT_FILES: Verdict = { files: false }

/** The file's module paths, or `null` (every noted timer is the file's) when they can't be read. */
function fileModulesOf(read: (() => Iterable<string>) | undefined): ReadonlySet<string> | null {
  if (read === undefined) return null
  try {
    return new Set(read())
  } catch {
    return null
  }
}

/** The name of the function the wrappers hand Node's timers, which a stack walk stops at. */
const WRAPPER_NAME = 'provinoWindowTimerCallback'

/**
 * Whose a pending timer is, from the frames that set it (the header's rules). The walk stops at
 * the first frame that decides, so a frame past it is never read: turning a module's `file:` URL
 * into a path costs more than the rest of the walk, and it is done once per name per file.
 */
function verdictOf(origin: Origin, own: ReadonlySet<string>, tracking: Tracking): Verdict {
  const frames = callSitesOf(origin.site)
  const { within } = origin
  // No frame was kept (`Error.stackTraceLimit` is 0): the callback's it was set inside, else the
  // file's, as nothing tells otherwise.
  if (frames.length === 0) return within ?? FILES
  let facts: CallbackFacts | undefined
  let owner: string | undefined
  for (const frame of frames) {
    if (frame.getFunctionName() === WRAPPER_NAME) return inside(within, owner)
    const file = fileOf(frame.getFileName(), tracking)
    if (file === null) continue
    if (own.has(file.path)) return { files: true, owner }
    if (file.kind === 'provino') return NOT_FILES
    if (owner === undefined && file.kind === 'shared') {
      facts ??= factsOf(origin.callback, tracking)
      // A bound or native callback has no source to look for: the shared frame that set it owns it.
      if (!facts.readable || holdsCallback(file.path, facts, tracking)) owner = file.path
    }
  }
  // The stack was cut (`Error.stackTraceLimit`) before it reached the wrapper it was set inside.
  if (within !== undefined) return inside(within, owner)
  return owner === undefined ? NOT_FILES : { files: true, owner }
}

/**
 * A timer whose walk reached the callback it was set inside: that callback's timer's verdict,
 * owned by the first shared frame the walk passed, else by that timer's owner. A wrapper frame of
 * no timer of this file's (one noted for an earlier file) is Provino's code, as any other is.
 */
function inside(within: Verdict | undefined, owner: string | undefined): Verdict {
  if (within === undefined || !within.files) return NOT_FILES
  return owner === undefined && within.owner === undefined
    ? FILES
    : { files: true, owner: owner ?? within.owner }
}

/** The captured frames, outermost last, read with our own formatter whatever the process has. */
function callSitesOf(site: Origin['site']): readonly NodeJS.CallSite[] {
  const previous = Error.prepareStackTrace
  Error.prepareStackTrace = (_error, frames) => frames
  let frames: unknown
  try {
    frames = site.stack
  } finally {
    Error.prepareStackTrace = previous
  }
  return Array.isArray(frames) ? (frames as NodeJS.CallSite[]) : NO_FRAMES
}

const NO_FRAMES: readonly NodeJS.CallSite[] = []

/** A frame's file, once per file name per window file: `null` for one that is not on disk. */
function fileOf(name: string | null | undefined, tracking: Tracking): FileFacts | null {
  if (name === null || name === undefined) return null
  let file = tracking.files.get(name)
  if (file === undefined) {
    const path = pathOf(name)
    file =
      path === null
        ? null
        : {
            path,
            kind: isProvinoFile(path) ? 'provino' : isSharedPackageFile(path) ? 'shared' : 'other',
          }
    tracking.files.set(name, file)
  }
  return file
}

function factsOf(callback: object, tracking: Tracking): CallbackFacts {
  let facts = tracking.callbacks.get(callback)
  if (facts === undefined) {
    const text = Function.prototype.toString.call(callback)
    facts = { text, readable: !text.includes('[native code]'), holds: new Map() }
    tracking.callbacks.set(callback, facts)
  }
  return facts
}

/** Whether a shared file's source holds the callback (read once per file and callback). */
function holdsCallback(file: string, facts: CallbackFacts, tracking: Tracking): boolean {
  let holds = facts.holds.get(file)
  if (holds === undefined) {
    holds = sourceOf(file, tracking.sources)?.includes(facts.text) === true
    facts.holds.set(file, holds)
  }
  return holds
}

function pathOf(name: string): string | null {
  if (name.startsWith('file:')) return fileURLToPath(name)
  return isAbsolute(name) ? name : null
}

/** A `node_modules` file: what a frame outside the file's registry is when Node loaded it. */
function isSharedPackageFile(file: string): boolean {
  return file.replaceAll('\\', '/').includes('/node_modules/')
}

/**
 * The directory of Provino's own packages when this code runs from a workspace checkout
 * (`<repo>/packages/`), else `undefined`: the same rule as the failure text's frames
 * (`results/failure-message.ts` `isProvinoFrame`).
 */
const PROVINO_PACKAGES: string | undefined = (() => {
  const path = fileURLToPath(import.meta.url).replaceAll('\\', '/')
  return /^(.*\/packages\/)[^/]+\/(?:src|dist)\//.exec(path)?.[1]
})()

/** Provino's own code: an installed `provino` or `@provino/*`, or this checkout's packages. */
function isProvinoFile(file: string): boolean {
  const path = file.replaceAll('\\', '/')
  if (/\/node_modules\/(?:provino|@provino\/[^/]+)\//.test(path)) return true
  if (PROVINO_PACKAGES === undefined || !path.startsWith(PROVINO_PACKAGES)) return false
  return /^[^/]+\/(?:src|dist)\//.test(path.slice(PROVINO_PACKAGES.length))
}

function sourceOf(file: string, sources: Map<string, string | null>): string | null {
  let source = sources.get(file)
  if (source === undefined) {
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      source = null
    }
    sources.set(file, source)
  }
  return source
}
