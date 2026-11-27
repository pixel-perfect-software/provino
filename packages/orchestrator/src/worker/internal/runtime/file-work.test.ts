// The settling of a window file's one-shot work (`file-work.ts`, #227), over a stand-in global
// whose timers record what they are asked: the drain's turns, its bound, what it clears, and what
// passes through untouched.
import { promisify } from 'node:util'
import { describe, expect, test } from 'provino'
import { DRAIN_TURNS, type FileWork, installFileWorkTracking, settleFileWork } from './file-work.ts'

/** A global whose `setImmediate` is Node's and whose `setTimeout` only records (no real wait). */
function standIn() {
  const timeouts = new Map<object, () => void>()
  const cleared: unknown[] = []
  const interval = (): void => {}
  const realImmediate = (fn: () => void): NodeJS.Immediate => setImmediate(fn)
  Object.defineProperty(realImmediate, promisify.custom, { value: 'custom', configurable: true })
  const target: Record<string, unknown> = {
    setImmediate: realImmediate,
    clearImmediate: (handle: NodeJS.Immediate) => {
      cleared.push(handle)
      clearImmediate(handle)
    },
    setTimeout: (fn: () => void) => {
      const handle = {}
      timeouts.set(handle, fn)
      return handle
    },
    clearTimeout: (handle: object) => {
      cleared.push(handle)
      timeouts.delete(handle)
    },
    setInterval: interval,
  }
  return { target, timeouts, cleared, interval }
}

type Timers = {
  setImmediate(fn: () => void): unknown
  setTimeout(fn: () => void, ms?: number): object
  clearTimeout(handle: unknown): void
}

function setUp() {
  const global = standIn()
  let current: FileWork | undefined
  const tracking = installFileWorkTracking(global.target, () => current)
  const timers = global.target as unknown as Timers
  return {
    ...global,
    timers,
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

describe('settling a window file’s work', () => {
  test('nothing pending: no turn and nothing cleared', async () => {
    const t = setUp()
    try {
      const work = t.open()
      expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 0 })
    } finally {
      t.tracking.uninstall()
    }
  })

  test('a queued immediate runs while the window is up, and a scheduler-style flag clears', async () => {
    const t = setUp()
    try {
      const work = t.open()
      let posted = true
      t.timers.setImmediate(() => {
        posted = false
      })
      const settled = await settleFileWork(work)
      expect(posted).toBe(false)
      expect(settled.cleared).toBe(0)
      expect(settled.turns).toBeGreaterThan(0)
    } finally {
      t.tracking.uninstall()
    }
  })

  test('a loop that reschedules itself is cut off at the bound and cleared', async () => {
    const t = setUp()
    try {
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
    } finally {
      t.tracking.uninstall()
    }
  })

  test('a longer timeout is cleared without waiting for it; a 0 ms one is waited for', async () => {
    const t = setUp()
    try {
      const work = t.open()
      const long = t.timers.setTimeout(() => {}, 5000)
      expect(work.drainable).toBe(0)
      expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 1 })
      expect(t.cleared).toEqual([long])
      const next = t.open()
      t.timers.setTimeout(() => {})
      expect(next.drainable).toBe(1)
      next.pending.clear()
      next.drainable = 0
      await settleFileWork(next)
    } finally {
      t.tracking.uninstall()
    }
  })

  test('a clear, from any context, forgets the work; so does its callback running', async () => {
    const t = setUp()
    try {
      const work = t.open()
      const handle = t.timers.setTimeout(() => {}, 0)
      t.leave()
      t.timers.clearTimeout(handle)
      expect(work.pending.size).toBe(0)
      expect(work.drainable).toBe(0)
      const again = t.open()
      t.timers.setTimeout(() => {}, 0)
      const [, fire] = [...t.timeouts.entries()].at(-1) ?? []
      fire?.()
      expect(again.pending.size).toBe(0)
      expect(again.drainable).toBe(0)
      await settleFileWork(work)
      await settleFileWork(again)
    } finally {
      t.tracking.uninstall()
    }
  })

  test('work with no file in its context, and after the file settled, passes through', async () => {
    const t = setUp()
    try {
      const work = t.open()
      t.leave()
      t.timers.setTimeout(() => {}, 0)
      expect(work.pending.size).toBe(0)
      await settleFileWork(work)
      t.timers.setTimeout(() => {}, 0)
      expect(work.pending.size).toBe(0)
      expect(await settleFileWork(work)).toEqual({ turns: 0, cleared: 0 })
    } finally {
      t.tracking.uninstall()
    }
  })
})

describe('the wrappers on a global', () => {
  test('intervals are not wrapped; the others keep their name and promisify form', () => {
    const t = setUp()
    try {
      expect(t.target.setInterval).toBe(t.interval)
      expect((t.target.setImmediate as { name: string }).name).toBe('setImmediate')
      expect((t.target.setImmediate as Record<symbol, unknown>)[promisify.custom]).toBe('custom')
    } finally {
      t.tracking.uninstall()
    }
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
