// The settling of a window file's one-shot work (`file-work.ts`, #227), over a stand-in global
// whose timers record what they are asked: the drain's turns, its bound, what it clears, and what
// passes through untouched; then over Node's own timers for what only Node's handles carry (the
// liveness a `node:timers` clear leaves, and a clear by numeric id).
import * as nodeTimers from 'node:timers'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'provino'
import {
  DRAIN_TURNS,
  type FileWork,
  type FileWorkTracking,
  installFileWorkTracking,
  settleFileWork,
} from './file-work.ts'

/** A stand-in timeout: never fires by itself; `fire` runs it, as Node marks a fired one. */
class StandInTimeout {
  _destroyed = false
  readonly id: number
  readonly fn: () => void
  readonly #armed: Map<number, StandInTimeout>
  constructor(id: number, fn: () => void, armed: Map<number, StandInTimeout>) {
    this.id = id
    this.fn = fn
    this.#armed = armed
  }
  fire(): void {
    this.#armed.delete(this.id)
    this._destroyed = true
    this.fn()
  }
  refresh(): this {
    this._destroyed = false
    this.#armed.set(this.id, this)
    return this
  }
  [Symbol.toPrimitive](): number {
    return this.id
  }
}

/** A global whose `setImmediate` is Node's and whose `setTimeout` only records (no real wait). */
function standIn() {
  const timeouts = new Map<number, StandInTimeout>()
  const cleared: unknown[] = []
  const interval = (): void => {}
  let nextId = 1
  const realImmediate = (fn: () => void): NodeJS.Immediate => setImmediate(fn)
  Object.defineProperty(realImmediate, promisify.custom, { value: 'custom', configurable: true })
  /** The stand-in's own clear, which the wrappers never see (as `node:timers`' is). */
  const rawClearTimeout = (handle: unknown): void => {
    cleared.push(handle)
    const timeout = typeof handle === 'number' ? timeouts.get(handle) : handle
    if (timeout instanceof StandInTimeout) {
      timeout._destroyed = true
      timeouts.delete(timeout.id)
    }
  }
  const target: Record<string, unknown> = {
    setImmediate: realImmediate,
    clearImmediate: (handle: NodeJS.Immediate) => {
      cleared.push(handle)
      clearImmediate(handle)
    },
    setTimeout: (fn: () => void) => {
      const handle = new StandInTimeout(nextId++, fn, timeouts)
      timeouts.set(handle.id, handle)
      return handle
    },
    clearTimeout: rawClearTimeout,
    setInterval: interval,
  }
  return { target, timeouts, cleared, interval, rawClearTimeout }
}

type Timers = {
  setImmediate(fn: () => void): unknown
  setTimeout(fn: () => void, ms?: number): StandInTimeout
  clearTimeout(handle: unknown): void
}

/** Every tracking a test installed, taken off after it. */
const installs: FileWorkTracking[] = []
afterEach(() => {
  for (const tracking of installs.splice(0)) tracking.uninstall()
})

/** Tracking over `target`, with `open` making a file current and `leave` making none. */
function tracked<T extends object>(target: T) {
  let current: FileWork | undefined
  const tracking = installFileWorkTracking(target, () => current)
  installs.push(tracking)
  return {
    tracking,
    open(): FileWork {
      current = tracking.track()
      return current
    },
    leave(): void {
      current = undefined
    },
  }
}

function setUp() {
  const global = standIn()
  return { ...global, ...tracked(global.target), timers: global.target as unknown as Timers }
}

/** Node's own timers on an object of their own (the worker's global is never touched). */
function nodeGlobal() {
  const target = { setImmediate, clearImmediate, setTimeout, clearTimeout }
  return { target, ...tracked(target) }
}

describe('settling a window file’s work', () => {
  test('nothing pending: no turn and nothing cleared', async () => {
    const t = setUp()
    const work = t.open()
    expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 0 })
  })

  test('a queued immediate runs while the window is up, and a scheduler-style flag clears', async () => {
    const t = setUp()
    const work = t.open()
    let posted = true
    t.timers.setImmediate(() => {
      posted = false
    })
    const settled = await settleFileWork(work)
    expect(posted).toBe(false)
    expect(settled.cleared).toBe(0)
    expect(settled.turns).toBeGreaterThan(0)
  })

  test('a loop that reschedules itself is cut off at the bound and cleared', async () => {
    const t = setUp()
    const work = t.open()
    let runs = 0
    const loop = (): void => {
      runs++
      t.timers.setImmediate(loop)
    }
    t.timers.setImmediate(loop)
    const settled = await settleFileWork(work)
    expect(settled.turns).toBe(DRAIN_TURNS)
    expect(settled.cleared).toBe(1)
    const after = runs
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(runs).toBe(after)
  })

  test('a longer timeout is cleared without waiting for it; a 0 ms one is waited for', async () => {
    const t = setUp()
    const work = t.open()
    const long = t.timers.setTimeout(() => {}, 5000)
    expect(work.shortTimers).toBe(0)
    expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 1 })
    expect(t.cleared).toEqual([long])
    const next = t.open()
    const short = t.timers.setTimeout(() => {})
    expect(next.shortTimers).toBe(1)
    t.timers.clearTimeout(short)
    expect(next.shortTimers).toBe(0)
    await settleFileWork(next)
  })

  test('a clear, from any context, forgets the work; its callback running stops the wait', async () => {
    const t = setUp()
    const work = t.open()
    const handle = t.timers.setTimeout(() => {}, 0)
    t.leave()
    t.timers.clearTimeout(handle)
    expect(work.pending.size).toBe(0)
    expect(work.shortTimers).toBe(0)
    const again = t.open()
    t.timers.setTimeout(() => {}, 0).fire()
    expect(again.shortTimers).toBe(0)
    await settleFileWork(work)
    expect(await settleFileWork(again)).toEqual({ turns: 0, cleared: 0 })
  })

  test('a timeout cleared by its numeric id stops the wait', async () => {
    const t = setUp()
    const work = t.open()
    const handle = t.timers.setTimeout(() => {}, 0)
    t.timers.clearTimeout(+handle)
    expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 0 })
  })

  test('a timeout cleared where the wrappers can’t see it stops the wait', async () => {
    const t = setUp()
    const work = t.open()
    t.rawClearTimeout(t.timers.setTimeout(() => {}, 0))
    expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 0 })
  })

  test('a timeout refreshed after it fired is still cleared at the settle', async () => {
    // A debounce or a keep-alive: the callback ran, then `refresh()` armed the timer again.
    const t = setUp()
    const work = t.open()
    const handle = t.timers.setTimeout(() => {}, 20)
    handle.fire()
    handle.refresh()
    expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 1 })
    expect(t.cleared).toEqual([handle])
    expect(t.timeouts.size).toBe(0)
  })

  test('work with no file in its context, and after the file settled, passes through', async () => {
    const t = setUp()
    const work = t.open()
    t.leave()
    t.timers.setTimeout(() => {}, 0)
    expect(work.pending.size).toBe(0)
    await settleFileWork(work)
    t.timers.setTimeout(() => {}, 0)
    expect(work.pending.size).toBe(0)
    expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 0 })
  })
})

describe('over Node’s own timers', () => {
  test('a timeout and an immediate cleared through node:timers stop the wait', async () => {
    const t = nodeGlobal()
    const work = t.open()
    nodeTimers.clearTimeout(t.target.setTimeout(() => {}, 0))
    nodeTimers.clearImmediate(t.target.setImmediate(() => {}))
    expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 0 })
  })

  test('a timeout cleared by its numeric id stops the wait, and the id still clears it', async () => {
    const t = nodeGlobal()
    const work = t.open()
    let fired = false
    const handle = t.target.setTimeout(() => {
      fired = true
    }, 0)
    t.target.clearTimeout(+handle)
    expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 0 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(fired).toBe(false)
  })
})

describe('the wrappers on a global', () => {
  test('intervals are not wrapped; the others keep their name and promisify form', () => {
    const t = setUp()
    expect(t.target.setInterval).toBe(t.interval)
    expect((t.target.setImmediate as { name: string }).name).toBe('setImmediate')
    expect((t.target.setImmediate as Record<symbol, unknown>)[promisify.custom]).toBe('custom')
  })

  test('a second install shares the first, and the last uninstall puts the originals back', () => {
    const global = standIn()
    const original = global.target.setTimeout
    const first = installFileWorkTracking(global.target, () => undefined)
    const wrapped = global.target.setTimeout
    const second = installFileWorkTracking(global.target, () => undefined)
    expect(second).toBe(first)
    expect(global.target.setTimeout).toBe(wrapped)
    second.uninstall()
    expect(global.target.setTimeout).toBe(wrapped)
    first.uninstall()
    expect(global.target.setTimeout).toBe(original)
    expect(wrapped).not.toBe(original)
  })

  test('a timer function something else put on the global since is left there', () => {
    const global = standIn()
    const tracking = installFileWorkTracking(global.target, () => undefined)
    const replaced = (): void => {}
    global.target.setTimeout = replaced
    tracking.uninstall()
    expect(global.target.setTimeout).toBe(replaced)
  })
})
