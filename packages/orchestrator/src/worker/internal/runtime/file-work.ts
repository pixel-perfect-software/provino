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
// queued is pending, at most `DRAIN_TURNS` (50) turns and `DRAIN_MS` (50 ms), and then clears what
// is left (a longer timeout, a timeout that fired and may be `refresh()`ed, or a loop that outran
// the bound). An error the drained work throws is an uncaught exception the runtime charges as it
// charges any late one.
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
// **Clears the wrappers don't see.** A tracked timeout cleared by its numeric id
// (`clearTimeout(+handle)`, which Node accepts once `Symbol.toPrimitive` gave the id) is found
// through the id: a tracked timeout's `Symbol.toPrimitive` notes the id it gives (`primitiveOf`,
// only on tracked handles). A timer cleared through `node:timers`' own `clearTimeout` or
// `clearImmediate` is never seen, so before each drain turn the entries whose handle is no longer
// live are dropped (`prune`). The signal is Node's `_destroyed` on a `Timeout` and an
// `Immediate` (internal, but set by every clear and by the callback's run on Node 22.15, 24.22 and
// 26.13, and put back to `false` by `refresh()`; `hasRef()` stays true after a clear). It is
// read only when it is a boolean: a handle without it counts as live, and the bound still caps the
// wait for one cleared out of sight.
//
// **A timeout that fired stays noted** (not waited for) until the file settles, so a `refresh()`
// after it fired (a debounce, a keep-alive) re-arms a timer the settle still clears. The cost is
// one map entry (and the `Timeout` with its callback kept alive) per fired timeout of a window
// file, until its settle; an immediate can't be re-armed and is dropped when it runs.
//
// **Where they go (#230).** Only in a worker that runs a window, and only when its isolation is not
// `none` (there the window outlives its files): the runner puts them on the global at the worker's
// first window file, right after that file's environment `setup` and before any of its modules
// load (`installWindowWork` in `runner.ts`), so a package that captures `setImmediate` as it loads
// captures the wrapper. A worker whose environment has no window keeps Node's own functions, so its
// timer calls cost what Node's do and no frame of Provino's sits in a stack captured at a timer's
// creation. That first file's environment read the global before they went on, and its teardown
// puts back what it read, so the runner then `reinstate`s them for the files after it. The timing
// holds because a worker runs one environment: boot loads only Provino's own modules, the
// environment and the dialect's factories, and a native project has no docblock environment (no
// `environmentResolver`). A dialect that turned the key on and resolved docblocks could run a
// non-window file first, and a shared package it loaded would keep Node's own timers in the
// worker's later window files. Where Provino prints a stack captured at a timer's creation (the
// open-handle report), the wrappers' frames are left out as Provino's own. While no window file is
// tracked they pass the call through with nothing allocated (`openFiles.size === 0`).
//
// **The bound.** `DRAIN_TURNS` (50) whole turns or `DRAIN_MS` (50 ms), whichever comes first. A
// React commit's queued flush and the effects it schedules take one to three turns; React's
// scheduler yields every 5 ms, so 50 ms is ten of its slices of real work. A loop that reschedules
// itself with immediates reaches 50 turns in about a millisecond, so a file pays at most that for
// work that never ends, and such a loop is then cleared (a shared scheduler cut off there keeps its
// flag set: the one case left stuck).
//
// **Cost** (`local`, Node 24.22.1, one `setTimeout` plus its `clearTimeout`, 200,000 times,
// medians of 7 rounds, 2026-11-27): Node's own 111 ns; the wrappers while no window file runs 118 ns;
// while one runs, for code outside its context, 134 ns (an `AsyncLocalStorage` read); for the file's
// own work 368 ns (the callback's wrapper, the map entry and the timeout's own `Symbol.toPrimitive`).
// Again on 2026-11-27 (`local`, the same method, on a machine running other work, so every number
// is higher): Node's own 199 ns, the wrappers idle 206 ns, a window file's code outside its context
// 215 ns and its own work 471 ns. With the key off, under isolation `none`, or in a worker that runs
// no window, nothing is installed and a timer call is Node's own.
import { nativeNow, nativeSetTimeout, nextMacrotask } from '../../timers.ts'

/** The most event-loop turns the drain waits for a file's work: about 2 ms for a loop of immediates. */
export const DRAIN_TURNS = 50
/** The longest the drain waits for a file's work, however few turns that is. */
const DRAIN_MS = 50

/** A timeout this short (Node makes 0 and anything below 1 into 1 ms) is drained, not just cleared. */
const SHORT_TIMEOUT_MS = 1

type Callback = (...args: unknown[]) => unknown

/** What the drain waits for: an immediate, a timeout of at most 1 ms, or nothing (`undefined`). */
type Wait = 'immediate' | 'timer' | undefined

/** One pending piece of work's kind: one object per kind and global, shared by every handle. */
interface Entry {
  readonly clear: (handle: unknown) => void
  readonly wait: Wait
  /**
   * What the entry becomes once nothing waits for it (its callback ran, or its handle is no longer
   * live): a timeout stays noted, since `refresh()` can re-arm it; `undefined` drops it.
   */
  after: Entry | undefined
}

/**
 * A window file's pending one-shot work, by handle. Made at the file's setup; `settle` drains it
 * and clears the rest when its window is about to close.
 * @internal
 */
export interface FileWork {
  /** False once settled: work the file's context queues later passes through. */
  open: boolean
  readonly pending: Map<unknown, Entry>
  /** Pending immediates, which the drain waits for. */
  immediates: number
  /** Pending timeouts of at most 1 ms, which the drain waits for. */
  shortTimers: number
  /** The ids tracked timeouts gave (`+handle`), so a clear by id finds the handle. */
  ids: Map<number, object> | undefined
}

/** What `settle` did: the turns it waited and the live pieces of work it cleared. */
interface Settled {
  readonly turns: number
  readonly cleared: number
}

/**
 * The wrappers on a global: `track` opens a window file's record, `reinstate` puts them back where
 * an environment's restore put Node's own back, `uninstall` takes them off.
 */
export interface FileWorkTracking {
  track(): FileWork
  /**
   * Puts each wrapper back on the global where the global holds Node's own function again: the
   * first window file's environment read the global before the wrappers went on, and its teardown
   * restores what it read. Anything else that replaced them stays.
   */
  reinstate(): void
  uninstall(): void
}

/** The tracking already on each global, with how many workers installed it (nested inline ones). */
const installed = new WeakMap<object, { tracking: FileWorkTracking; users: number }>()

/** Window files being tracked in this module, so the untracked path is one comparison. */
const openFiles = new Set<FileWork>()

/** The file each tracked handle belongs to, so a clear made from any context finds it. */
const owners = new WeakMap<object, FileWork>()

const PAIRS = [
  { set: 'setImmediate', clear: 'clearImmediate' },
  { set: 'setTimeout', clear: 'clearTimeout' },
] as const

function count(work: FileWork, wait: Wait, by: 1 | -1): void {
  if (wait === 'immediate') work.immediates += by
  else if (wait === 'timer') work.shortTimers += by
}

/** Whether the drain still waits for anything of the file's. */
function waiting(work: FileWork): boolean {
  return work.immediates > 0 || work.shortTimers > 0
}

/** Drops a handle's entry: it was cleared. */
function forget(work: FileWork, handle: unknown): void {
  const entry = work.pending.get(handle)
  if (entry === undefined) return
  work.pending.delete(handle)
  count(work, entry.wait, -1)
}

/** Nothing waits for a handle any more: its entry becomes `after`, or goes. */
function standDown(work: FileWork, handle: unknown, entry: Entry): void {
  count(work, entry.wait, -1)
  if (entry.after === undefined) work.pending.delete(handle)
  else if (entry.after !== entry) work.pending.set(handle, entry.after)
}

/** Whether Node still has the timer queued: `_destroyed` when Node gives it, else assumed live. */
function isLive(handle: unknown): boolean {
  if (typeof handle !== 'object' || handle === null) return true
  return (handle as { _destroyed?: unknown })._destroyed !== true
}

/** Stands down the waited-for entries whose handle a clear the wrappers never saw has ended. */
function prune(work: FileWork): void {
  if (!waiting(work)) return
  for (const [handle, entry] of work.pending) {
    if (entry.wait !== undefined && !isLive(handle)) standDown(work, handle, entry)
  }
}

/**
 * A tracked timeout's own `Symbol.toPrimitive`: Node's (the id a numeric `clearTimeout` takes),
 * and the id noted against the file, so that clear finds the handle.
 */
function primitiveOf(this: object, hint: unknown): unknown {
  const prototype = Object.getPrototypeOf(this) as Record<symbol, unknown>
  const id = Reflect.apply(prototype[Symbol.toPrimitive] as Callback, this, [hint])
  const work = owners.get(this)
  if (work !== undefined && typeof id === 'number') {
    work.ids ??= new Map()
    work.ids.set(id, this)
  }
  return id
}

/** The tracked handle a clear names: the handle itself, or the one an id was given for. */
function trackedHandle(handle: unknown): { work: FileWork; handle: unknown } | undefined {
  if (typeof handle === 'object' && handle !== null) {
    const work = owners.get(handle)
    return work === undefined ? undefined : { work, handle }
  }
  if (typeof handle !== 'number' && typeof handle !== 'string') return undefined
  const id = Number(handle)
  for (const work of openFiles) {
    const found = work.ids?.get(id)
    if (found !== undefined) return { work, handle: found }
  }
  return undefined
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
  const reinstates: (() => void)[] = []
  for (const { set, clear } of PAIRS) {
    const original = target[set]
    const originalClear = target[clear]
    if (typeof original !== 'function' || typeof originalClear !== 'function') continue
    const clearFn = originalClear as (handle: unknown) => void
    const immediate = set === 'setImmediate'
    const call = original as Callback
    // This pair's kinds of entry, made once: `waited` is what the drain waits for (an immediate, a
    // short timeout), `kept` a timeout it doesn't (a longer one, or one that ran), cleared at settle.
    const kept: Entry = { clear: clearFn, wait: undefined, after: undefined }
    kept.after = kept
    const waited: Entry = {
      clear: clearFn,
      wait: immediate ? 'immediate' : 'timer',
      after: immediate ? undefined : kept,
    }
    /** Hands Node `callback` in place of the file's, and notes the handle against `work`. */
    const noting = (
      work: FileWork,
      callback: Callback,
      entry: Entry,
      delay: unknown,
      rest: unknown[],
    ): unknown => {
      let handle: unknown
      const fn = function (this: unknown, ...args: unknown[]): unknown {
        const now = work.pending.get(handle)
        if (now !== undefined) standDown(work, handle, now)
        return Reflect.apply(callback, this, args)
      }
      handle = immediate ? call(fn, ...rest) : call(fn, delay, ...rest)
      work.pending.set(handle, entry)
      count(work, entry.wait, 1)
      if (typeof handle === 'object' && handle !== null) {
        owners.set(handle, work)
        const timeout = handle as Record<symbol, unknown>
        if (!immediate && typeof timeout[Symbol.toPrimitive] === 'function') {
          timeout[Symbol.toPrimitive] = primitiveOf
        }
      }
      return handle
    }
    /** The file whose code queues this, while its window is up; `undefined` passes it through. */
    const fileOf = (callback: unknown): FileWork | undefined => {
      if (openFiles.size === 0 || typeof callback !== 'function') return undefined
      const work = current()
      return work?.open === true ? work : undefined
    }
    // The untracked path passes the arguments on as they came, with no `arguments` object and no
    // `this` (Node's timers read neither): a few ns over Node's own (`local`, the header's Cost).
    const wrapped: Callback = immediate
      ? {
          setImmediate(callback: unknown, ...rest: unknown[]): unknown {
            const work = fileOf(callback)
            if (work === undefined)
              return rest.length === 0 ? call(callback) : call(callback, ...rest)
            return noting(work, callback as Callback, waited, undefined, rest)
          },
        }.setImmediate
      : {
          setTimeout(callback: unknown, delay?: unknown, ...rest: unknown[]): unknown {
            const work = fileOf(callback)
            if (work === undefined) {
              return rest.length === 0 ? call(callback, delay) : call(callback, delay, ...rest)
            }
            const entry = Number(delay) > SHORT_TIMEOUT_MS ? kept : waited
            return noting(work, callback as Callback, entry, delay, rest)
          },
        }.setTimeout
    const wrappedClear = {
      [clear](handle: unknown): void {
        if (openFiles.size !== 0) {
          const found = trackedHandle(handle)
          if (found !== undefined) forget(found.work, found.handle)
        }
        clearFn(handle)
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
    reinstates.push(() => {
      if (target[set] === original) target[set] = wrapped
      if (target[clear] === originalClear) target[clear] = wrappedClear
    })
    restores.push(() => {
      // Only while the global still holds ours: whatever replaced them since stays.
      if (target[set] === wrapped) target[set] = original
      if (target[clear] === wrappedClear) target[clear] = originalClear
    })
  }
  const tracking: FileWorkTracking = {
    track(): FileWork {
      const work: FileWork = {
        open: true,
        pending: new Map(),
        immediates: 0,
        shortTimers: 0,
        ids: undefined,
      }
      openFiles.add(work)
      return work
    },
    reinstate(): void {
      for (const reinstate of reinstates) reinstate()
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
  if (work.shortTimers === 0) return nextMacrotask()
  return new Promise((resolve) => nativeSetTimeout(resolve, SHORT_TIMEOUT_MS))
}

/**
 * Drains a window file's pending one-shot work while its window is alive, then clears what is
 * still pending, and closes the record. No turn when nothing waits. Called once, at the file's
 * teardown; a second call does nothing.
 * @internal
 */
export async function settleFileWork(work: FileWork): Promise<Settled> {
  if (!work.open) return { turns: 0, cleared: 0 }
  let turns = 0
  prune(work)
  if (waiting(work)) {
    const deadline = nativeNow() + DRAIN_MS
    while (waiting(work) && turns < DRAIN_TURNS && nativeNow() < deadline) {
      await nextTurn(work)
      turns++
      prune(work)
    }
  }
  work.open = false
  openFiles.delete(work)
  let cleared = 0
  for (const [handle, entry] of work.pending) {
    if (isLive(handle)) cleared++
    entry.clear(handle)
  }
  work.pending.clear()
  work.immediates = 0
  work.shortTimers = 0
  work.ids = undefined
  return { turns, cleared }
}
