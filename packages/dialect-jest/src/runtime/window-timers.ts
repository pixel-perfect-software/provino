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
// wrapper notes each timer it hands out, with the stack that set it (or the origin it inherits,
// below); when the window closes, the file's timers still pending are cancelled.
//
// **Which timers are the file's** is read from that stack, outward from where the timer was set,
// only when it is asked (a timer still pending at the end, or one whose callback sets another):
// - a frame in a module the file's registry evaluated (the test file, its modules, the externals
//   evaluated per file) makes it the file's;
// - a frame in Provino's own code (the coordinator's, in band; the loader's, whose parser keeps
//   timers of its own) makes it not the file's, and it runs as it would have;
// - a frame of a shared package (a `node_modules` file Node loaded once for the worker, D127)
//   whose source holds the callback makes that package the timer's owner, and the timer the file's.
// A stack with none of these (no frame read) is not the file's.
//
// **A timer set from the callback of one of the file's is the file's too.** A loop that schedules
// its next step from its own callback (React's scheduler: `performWorkUntilDeadline` calls
// `setImmediate(performWorkUntilDeadline)` while work remains) sets each later timer with only its
// own frames on the stack, below this wrapper's. So each noted timer's callback is wrapped to mark
// its origin (the timer that was set with a stack) as running for its synchronous part, and a
// timer set then takes that origin, with no stack captured, when the origin's own frames make it
// the file's: it is the file's, owned by the origin's package when one owned it, and the package
// goes per file as above once it is cancelled. The origin's verdict is read once (the file's
// modules read again only when it seems not the file's, since a module may have loaded since the
// last read), and kept: the frames don't change. A timer set from the callback of one that is not
// the file's (Provino's own, in band) has its own stack read, so the file's code still claims what
// it sets there. An interval's runs are the one timer under its one handle, noted once. A promise
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
// While a window file runs, a timer set with its stack captured costs about 1.7 µs more than
// Node's own `setTimeout` and `clearTimeout`, and one that inherits its origin about 0.13 µs more
// (`local`, Node 24, `Error.stackTraceLimit` as the process has it). Outside a window file the
// wrapper passes `arguments` through and allocates nothing: about 5 ns.
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

/**
 * Where a noted timer's ownership comes from: the callback and stack of the timer that was set
 * with a stack captured, shared by every timer set from its callback (and theirs) after it.
 */
interface Origin {
  readonly callback: unknown
  /** Holds the captured stack, read only when a verdict is needed. */
  readonly site: { stack?: unknown }
  /** Whose it is, once read (the frames it was set from don't change). */
  verdict: Verdict | undefined
}

/** A timer noted while a window file ran: how to cancel it, and whose verdict it takes. */
interface Noted {
  readonly clear: Clear
  readonly origin: Origin
}

/** One window file's noting: its pending timers by handle, and the sources read for them. */
interface Tracking {
  readonly notes: Map<unknown, Noted>
  readonly sources: Map<string, string | null>
  /** The file's modules as last read for an inherited timer (`undefined` before the first). */
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
  // While a noted timer's callback runs (its synchronous part): the file it was noted for, and its
  // origin. A timer set then takes that origin when the origin is the file's (`inherited`).
  let runningFor: Tracking | null = null
  let runningOrigin: Origin | null = null

  /** The origin of the callback running now when it is the file's, else `null`. */
  const inherited = (tracking: Tracking): Origin | null => {
    const origin = runningFor === tracking ? runningOrigin : null
    if (origin === null) return null
    // Read once per origin, with the modules the file has loaded so far: the frames it was set
    // from had run, so their modules are among them, and a later read gives the same verdict.
    let verdict = origin.verdict
    if (verdict === undefined) {
      // The modules are read once per file and again only when an origin seems not the file's,
      // since one of its frames may be in a module loaded after the last read. A shared owner is
      // the frame before any of the file's, so a stale read can't change a verdict that is.
      let own = tracking.own === undefined ? fileModulesOf(state.fileModules) : tracking.own
      if (own === null) return origin
      verdict = verdictOf(origin, own, tracking.sources)
      if (!verdict.files && tracking.own !== undefined) {
        own = fileModulesOf(state.fileModules)
        if (own === null) return origin
        verdict = verdictOf(origin, own, tracking.sources)
      }
      tracking.own = own
      origin.verdict = verdict
    }
    return verdict.files ? origin : null
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
        let origin = inherited(tracking)
        if (origin === null) {
          origin = { callback, site: {}, verdict: undefined }
          Error.captureStackTrace(origin.site, wrapped)
        }
        const owner = origin
        const { notes } = tracking
        // biome-ignore lint/complexity/noArguments: the parameter list stays one, for the path above
        const args: unknown[] = Array.prototype.slice.call(arguments)
        let handle: unknown
        // An interval's repeats are the one timer under its one handle: each run is the same note.
        args[0] = function (this: unknown, ...given: unknown[]): unknown {
          if (once) notes.delete(handle)
          const previousFor = runningFor
          const previousOrigin = runningOrigin
          runningFor = tracking
          runningOrigin = owner
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
      const tracking: Tracking = { notes: new Map(), sources: new Map(), own: undefined }
      noting = tracking
      let stopped = false
      return () => {
        if (stopped) return NONE
        stopped = true
        if (noting === tracking) noting = null
        const { notes, sources } = tracking
        if (notes.size === 0) return NONE
        const own = fileModulesOf(state.fileModules)
        const owners = new Set<string>()
        for (const [handle, noted] of notes) {
          const { origin } = noted
          // A timer that inherited its origin takes the verdict that origin's frames give.
          let verdict = FILES
          if (own !== null) {
            verdict = origin.verdict ?? verdictOf(origin, own, sources)
            origin.verdict = verdict
          }
          if (!verdict.files) continue
          noted.clear(handle)
          if (verdict.owner !== undefined) owners.add(verdict.owner)
        }
        return owners.size === 0 ? NONE : [...owners]
      }
    },
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

/** Whose a pending timer is, from the frames that set it (the header's three rules). */
function verdictOf(
  origin: Origin,
  own: ReadonlySet<string>,
  sources: Map<string, string | null>,
): Verdict {
  const files = framesOf(origin.site)
  // No frame was kept (`Error.stackTraceLimit` is 0): the file's, as nothing tells otherwise.
  if (files.length === 0) return FILES
  // A bound or native callback has no source to look for: the shared frame that set it owns it.
  const text = Function.prototype.toString.call(origin.callback)
  const readable = !text.includes('[native code]')
  let owner: string | undefined
  for (const file of files) {
    if (file === null) continue
    if (own.has(file)) return { files: true, owner }
    if (isProvinoFile(file)) return NOT_FILES
    if (owner === undefined && isSharedPackageFile(file)) {
      if (!readable || sourceOf(file, sources)?.includes(text) === true) owner = file
    }
  }
  return owner === undefined ? NOT_FILES : { files: true, owner }
}

/** The file of each captured frame, outermost last (`null` for one with no file on disk). */
function framesOf(site: Origin['site']): readonly (string | null)[] {
  const previous = Error.prepareStackTrace
  Error.prepareStackTrace = (_error, frames) => frames
  let frames: unknown
  try {
    frames = site.stack
  } finally {
    Error.prepareStackTrace = previous
  }
  if (!Array.isArray(frames)) return NONE
  return frames.map((frame: NodeJS.CallSite) => pathOf(frame.getFileName()))
}

function pathOf(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null
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
