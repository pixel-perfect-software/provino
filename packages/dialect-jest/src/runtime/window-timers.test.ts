// The timer wrappers a Jest window environment puts on the worker's global (`window-timers.ts`),
// over a stand-in global whose timers record what they were asked: no real time passes.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import { installWindowTimers } from './window-timers.ts'

interface Scheduled {
  readonly kind: string
  readonly callback: (...args: unknown[]) => unknown
  readonly args: readonly unknown[]
}

/** A global whose six timer functions note what they are asked, with a promise form on two. */
function standIn() {
  const scheduled: Scheduled[] = []
  const cleared: unknown[] = []
  const schedule =
    (kind: string) =>
    (callback: (...args: unknown[]) => unknown, ...args: unknown[]): Scheduled => {
      const handle = { kind, callback, args }
      scheduled.push(handle)
      return handle
    }
  const clear = (handle: unknown): void => {
    cleared.push(handle)
  }
  const setTimeout = Object.assign(schedule('timeout'), {
    [promisify.custom]: () => Promise.resolve('timeout promise'),
  })
  const setImmediate = Object.assign(schedule('immediate'), {
    [promisify.custom]: () => Promise.resolve('immediate promise'),
  })
  const global: Record<string, unknown> = {
    setTimeout,
    clearTimeout: clear,
    setInterval: schedule('interval'),
    clearInterval: clear,
    setImmediate,
    clearImmediate: clear,
  }
  const call = (key: string, ...args: unknown[]): Scheduled =>
    (global[key] as (...rest: unknown[]) => Scheduled)(...args)
  // Node's timers take the delay before the callback's arguments; an immediate takes none.
  const fire = (handle: Scheduled): unknown =>
    Reflect.apply(
      handle.callback,
      handle,
      handle.kind === 'immediate' ? handle.args : handle.args.slice(1),
    )
  return { global, scheduled, cleared, call, fire, originals: { ...global } }
}

describe('installWindowTimers', () => {
  it('cancels the timers a window file left pending, of every kind', () => {
    const { global, cleared, call } = standIn()
    const timers = installWindowTimers(global)
    timers.begin()
    const timeout = call('setTimeout', () => {}, 20)
    const interval = call('setInterval', () => {}, 20)
    const immediate = call('setImmediate', () => {})
    timers.cancelPending()
    assert.deepEqual(cleared, [timeout, interval, immediate])
  })

  it('leaves a timer that fired or was cleared, and keeps calling the callback with its arguments', () => {
    const { global, cleared, call, fire } = standIn()
    const timers = installWindowTimers(global)
    timers.begin()
    const seen: unknown[] = []
    const fired = call('setTimeout', (...args: unknown[]) => seen.push(...args), 5, 'a', 'b')
    const gone = call('setImmediate', () => {})
    assert.equal(fire(fired), 2, "the callback's own return value")
    assert.deepEqual(seen, ['a', 'b'])
    call('clearImmediate', gone)
    assert.deepEqual(cleared, [gone])
    timers.cancelPending()
    assert.deepEqual(cleared, [gone], 'nothing was left to cancel')
  })

  it('notes nothing outside a window file, so a timer then outlives it', () => {
    const { global, cleared, call, scheduled } = standIn()
    const timers = installWindowTimers(global)
    const callback = () => {}
    call('setTimeout', callback, 1)
    assert.equal(scheduled[0]?.callback, callback, 'handed to the timer as it is')
    timers.begin()
    timers.cancelPending()
    call('setTimeout', () => {}, 1)
    timers.cancelPending()
    assert.deepEqual(cleared, [])
  })

  it('is installed once per global, and keeps the names and the promise forms', async () => {
    const { global, originals } = standIn()
    const first = installWindowTimers(global)
    const wrapped = { ...global }
    assert.equal(installWindowTimers(global), first)
    assert.deepEqual(global, wrapped, 'a second install wraps nothing again')
    for (const key of Object.keys(originals)) {
      assert.notEqual(global[key], originals[key], `${key} is wrapped`)
      assert.equal((global[key] as { name: string }).name, key)
    }
    const timeout = global.setTimeout as unknown as Record<symbol, () => Promise<string>>
    assert.equal(await timeout[promisify.custom]?.(), 'timeout promise')
    const immediate = global.setImmediate as unknown as Record<symbol, () => Promise<string>>
    assert.equal(await immediate[promisify.custom]?.(), 'immediate promise')
  })

  it('passes a callback that is not a function to the timer, which refuses it', () => {
    const { global, scheduled, call } = standIn()
    installWindowTimers(global).begin()
    call('setTimeout', 'not a function', 1)
    assert.equal(scheduled[0]?.callback, 'not a function')
  })
})
