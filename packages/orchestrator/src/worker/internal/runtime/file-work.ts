// The one-shot work a window file queued on Node's timers, settled when its window closes (#227,
// `orchestrator.windowFileWork: 'drain-then-cancel'`).
//
// In a native jsdom file the window is populated onto the worker's global, whose `setImmediate`
// and `setTimeout` are Node's: a package that takes `setImmediate` as it loads (React's scheduler,
// `localSetImmediate`) posts its flush there, and a flush still queued when the file ends runs after
// the window is gone (`window is not defined`, charged to the file's last test). Jest's window has
// no `setImmediate`, and `window.close()` cancels the window's own timers.
//
// Cancelling alone is not enough here: a node_modules package is shared by the worker's files, and
// a scheduler keeps a "flush posted" flag that only the flush itself clears (scheduler 0.28's
// `isMessageLoopRunning`), so a cancelled flush would leave every later file's work unscheduled. So
// the file's pending one-shot work is first drained, while the window is still there: the worker
// yields whole event-loop turns while an immediate or a timeout of at most 1 ms that the file
// queued is pending, at most `DRAIN_TURNS` turns and `DRAIN_MS` ms, and then clears what is left
// (a longer timeout, or a loop that outran the bound). An error the drained work throws is an
// uncaught exception the runtime charges as it charges any late one.
//
// **Whose work it is** is read from the async context: the wrappers ask the runner's `fileScope`
// store (`FileScope.work`) for the file whose code is running, so a callback a file queued, and
// what that callback queues in turn (a loop that reschedules itself), is the file's; code with no
// file in its context (the coordinator's, in an inline pool) is no file's and passes through.
//
// **What is left alone:** intervals (`setInterval` is not wrapped), `MessagePort`s and
// `node:timers`' own exports. A shared package may start an interval or open a port in whichever
// file uses it first and keep it for every later file, so closing those with the first file would
// break the package for the rest of the worker.
//
// The wrappers go on the global once per worker, at boot, before any file loads anything, so a
// package that captures `setImmediate` as it loads captures the wrapper. While no window file is
// tracked they pass the call through with nothing allocated (`openFiles === 0`).
//
// **The bound.** `DRAIN_TURNS` (50) whole turns or `DRAIN_MS` (50 ms), whichever comes first. A
// React commit's queued flush and the effects it schedules take one to three turns; React's
// scheduler yields every 5 ms, so 50 ms is ten of its slices of real work. A loop that reschedules
// itself with immediates reaches 50 turns in about a millisecond, so a file pays at most that for
// work that never ends, and such a loop is then cleared (a shared scheduler cut off there keeps its
// flag set: the one case left stuck).
//
// **Cost** (`local`, Node 24.22, one `setTimeout` plus its `clearTimeout`, 200,000 times): Node's
// own 213 ns; the wrappers while no window file runs 228 ns; while one runs, for code outside its
// context, 235 ns (an `AsyncLocalStorage` read); for the file's own work 528 ns (the callback's
// wrapper and the map entries). With the key off nothing is installed.
import { nativeSetImmediate, nativeSetTimeout } from '../../timers.ts'

/** The most event-loop turns the drain waits for a file's work: about 2 ms for a loop of immediates. */
export const DRAIN_TURNS = 50
/** The longest the drain waits for a file's work, however few turns that is. */
export const DRAIN_MS = 50

/** A timeout this short (Node makes 0 and anything below 1 into 1 ms) is drained, not just cleared. */
const SHORT_TIMEOUT_MS = 1

type Callback = (...args: unknown[]) => unknown

/** One pending piece of work: how to clear it, and whether the drain waits for it. */
interface Pending {
  readonly clear: (handle: unknown) => void
  readonly drained: boolean
  /** An immediate, which the next check phase runs: the drain's turn is then an immediate too. */
  readonly immediate: boolean
}

/**
 * A window file's pending one-shot work, by handle. Made at the file's setup; `settle` drains it
 * and clears the rest when its window is about to close.
 * @internal
 */
export interface FileWork {
  /** False once settled: work the file's context queues later passes through. */
  open: boolean
  readonly pending: Map<unknown, Pending>
  /** How many entries of `pending` the drain waits for. */
  drainable: number
}

/** What `settle` did: the turns it waited and the pieces of work it cleared. */
export interface Settled {
  readonly turns: number
  readonly cleared: number
}

/** The wrappers on a global: `track` opens a window file's record, `uninstall` takes them off. */
export interface FileWorkTracking {
  track(): FileWork
  uninstall(): void
}

/** The tracking already on each global, with how many workers installed it (nested inline ones). */
const installed = new WeakMap<object, { tracking: FileWorkTracking; users: number }>()

/** Window files being tracked in this module, so the untracked path is one comparison. */
let openFiles = 0

/** The file each tracked handle belongs to, so a clear made from any context finds it. */
const owners = new WeakMap<object, FileWork>()

const PAIRS = [
  { set: 'setImmediate', clear: 'clearImmediate' },
  { set: 'setTimeout', clear: 'clearTimeout' },
] as const

function forget(work: FileWork, handle: unknown): void {
  const entry = work.pending.get(handle)
  if (entry === undefined) return
  work.pending.delete(handle)
  if (entry.drained) work.drainable--
}

/**
 * Puts the wrappers on `global` (once per global: a nested worker in the same process shares the
 * first one's, and the last `uninstall` takes them off). `current` names the file whose code is
 * running, from its async context; `undefined` is no file's.
 * @internal
 */
export function installFileWorkTracking(
  global: object,
  current: () => FileWork | undefined,
): FileWorkTracking {
  const known = installed.get(global)
  if (known !== undefined) {
    known.users++
    return known.tracking
  }
  const target = global as Record<string, unknown>
  const restores: (() => void)[] = []
  for (const { set, clear } of PAIRS) {
    const original = target[set]
    const originalClear = target[clear]
    if (typeof original !== 'function' || typeof originalClear !== 'function') continue
    const clearFn = originalClear as (handle: unknown) => void
    const immediate = set === 'setImmediate'
    const call = original as Callback
    /** Hands Node `callback` in place of the file's, and notes the handle against `work`. */
    const noting = (
      work: FileWork,
      callback: Callback,
      delay: unknown,
      queue: (fn: Callback) => unknown,
    ): unknown => {
      let handle: unknown
      handle = queue(function (this: unknown, ...args: unknown[]): unknown {
        forget(work, handle)
        return Reflect.apply(callback, this, args)
      })
      const drained = immediate || !(Number(delay) > SHORT_TIMEOUT_MS)
      work.pending.set(handle, { clear: clearFn, drained, immediate })
      if (drained) work.drainable++
      if (typeof handle === 'object' && handle !== null) owners.set(handle, work)
      return handle
    }
    /** The file whose code queues this, while its window is up; `undefined` passes it through. */
    const fileOf = (callback: unknown): FileWork | undefined => {
      if (openFiles === 0 || typeof callback !== 'function') return undefined
      const work = current()
      return work?.open === true ? work : undefined
    }
    // The untracked path passes the arguments on as they came, with no `arguments` object and no
    // `this` (Node's timers read neither): about 15 ns over Node's own (`local`, the header's Cost).
    const wrapped: Callback = immediate
      ? {
          setImmediate(callback: unknown, ...rest: unknown[]): unknown {
            const work = fileOf(callback)
            if (work === undefined)
              return rest.length === 0 ? call(callback) : call(callback, ...rest)
            return noting(work, callback as Callback, 0, (fn) => call(fn, ...rest))
          },
        }.setImmediate
      : {
          setTimeout(callback: unknown, delay?: unknown, ...rest: unknown[]): unknown {
            const work = fileOf(callback)
            if (work === undefined) {
              return rest.length === 0 ? call(callback, delay) : call(callback, delay, ...rest)
            }
            return noting(work, callback as Callback, delay, (fn) => call(fn, delay, ...rest))
          },
        }.setTimeout
    const wrappedClear = {
      [clear](this: unknown, handle: unknown): void {
        if (openFiles !== 0 && typeof handle === 'object' && handle !== null) {
          const work = owners.get(handle)
          if (work !== undefined) forget(work, handle)
        }
        clearFn.call(this, handle)
      },
    }[clear] as (handle: unknown) => void
    // `util.promisify` reads its custom form off the function a package holds.
    for (const key of Reflect.ownKeys(original)) {
      if (typeof key !== 'symbol') continue
      const descriptor = Reflect.getOwnPropertyDescriptor(original, key)
      if (descriptor !== undefined) Reflect.defineProperty(wrapped, key, descriptor)
    }
    // Node's timer globals are writable data properties, so an assignment keeps their attributes.
    target[set] = wrapped
    target[clear] = wrappedClear
    restores.push(() => {
      // Only while the global still holds ours: whatever replaced them since stays.
      if (target[set] === wrapped) target[set] = original
      if (target[clear] === wrappedClear) target[clear] = originalClear
    })
  }
  const tracking: FileWorkTracking = {
    track(): FileWork {
      openFiles++
      return { open: true, pending: new Map(), drainable: 0 }
    },
    uninstall(): void {
      const entry = installed.get(global)
      if (entry === undefined) return
      entry.users--
      if (entry.users > 0) return
      installed.delete(global)
      for (const restore of restores) restore()
    },
  }
  installed.set(global, { tracking, users: 1 })
  return tracking
}

/** One whole event-loop turn: an immediate when only immediates wait, else the next timer. */
function nextTurn(work: FileWork): Promise<void> {
  let onlyImmediates = true
  for (const entry of work.pending.values()) {
    if (entry.drained && !entry.immediate) onlyImmediates = false
  }
  return new Promise((resolve) => {
    if (onlyImmediates) nativeSetImmediate(resolve)
    else nativeSetTimeout(resolve, SHORT_TIMEOUT_MS)
  })
}

/**
 * Drains a window file's pending one-shot work while its window is alive, then clears what is
 * still pending, and closes the record. No turn when nothing waits. Called once, at the file's
 * teardown; a second call does nothing.
 * @internal
 */
export async function settleFileWork(
  work: FileWork,
  now: () => number = performance.now.bind(performance),
): Promise<Settled> {
  if (!work.open) return { turns: 0, cleared: 0 }
  let turns = 0
  try {
    const deadline = work.drainable > 0 ? now() + DRAIN_MS : 0
    while (work.drainable > 0 && turns < DRAIN_TURNS && now() < deadline) {
      await nextTurn(work)
      turns++
    }
  } finally {
    work.open = false
    openFiles--
  }
  let cleared = 0
  for (const [handle, entry] of work.pending) {
    entry.clear(handle)
    cleared++
  }
  work.pending.clear()
  work.drainable = 0
  return { turns, cleared }
}
