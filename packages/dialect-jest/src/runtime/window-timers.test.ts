// The timer wrappers a Jest window environment puts on the worker's global (`window-timers.ts`),
// over a stand-in global whose timers record what they were asked: no real time passes. Which code
// set a timer is read from its stack, so the "file's code" and the "shared package" here are real
// modules written to a temporary directory and loaded by Node, outside Provino's own packages
// (this test file is inside them, so a timer it sets itself is Provino's, as the coordinator's is).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
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
    const stop = installWindowTimers(global).track()
    const timeout = call('setTimeout', () => {}, 20)
    const interval = call('setInterval', () => {}, 20)
    const immediate = call('setImmediate', () => {})
    assert.deepEqual(stop(), [], 'no shared package owned one')
    assert.deepEqual(cleared, [timeout, interval, immediate])
  })

  it('leaves a timer that fired or was cleared, and keeps calling the callback with its arguments', () => {
    const { global, cleared, call, fire } = standIn()
    const stop = installWindowTimers(global).track()
    const seen: unknown[] = []
    const fired = call('setTimeout', (...args: unknown[]) => seen.push(...args), 5, 'a', 'b')
    const gone = call('setImmediate', () => {})
    assert.equal(fire(fired), 2, "the callback's own return value")
    assert.deepEqual(seen, ['a', 'b'])
    call('clearImmediate', gone)
    assert.deepEqual(cleared, [gone])
    stop()
    assert.deepEqual(cleared, [gone], 'nothing was left to cancel')
  })

  it('notes nothing outside a window file, so a timer then outlives it', () => {
    const { global, cleared, call, scheduled } = standIn()
    const timers = installWindowTimers(global)
    const callback = () => {}
    call('setTimeout', callback, 1)
    assert.equal(scheduled[0]?.callback, callback, 'handed to the timer as it is')
    const stop = timers.track()
    stop()
    call('setTimeout', () => {}, 1)
    stop()
    assert.deepEqual(cleared, [], 'a second stop does nothing')
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
      const descriptor = Object.getOwnPropertyDescriptor(global, key)
      assert.deepEqual(
        { writable: descriptor?.writable, enumerable: descriptor?.enumerable },
        { writable: true, enumerable: true },
        `${key} keeps its attributes`,
      )
    }
    const timeout = global.setTimeout as unknown as Record<symbol, () => Promise<string>>
    assert.equal(await timeout[promisify.custom]?.(), 'timeout promise')
    const immediate = global.setImmediate as unknown as Record<symbol, () => Promise<string>>
    assert.equal(await immediate[promisify.custom]?.(), 'immediate promise')
  })

  it('passes a callback that is not a function to the timer, which refuses it', () => {
    const { global, scheduled, call } = standIn()
    installWindowTimers(global).track()
    call('setTimeout', 'not a function', 1)
    assert.equal(scheduled[0]?.callback, 'not a function')
  })
})

describe('which pending timers are the file’s', () => {
  let dir = ''
  let load: NodeJS.Require
  /** The file's own module: sets a timer, calls the package, hands it a callback. */
  let user: {
    timer(global: Record<string, unknown>): unknown
    run<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): unknown
    laterVia(later: typeof shared.later, global: Record<string, unknown>): unknown
    path: string
  }
  /** A shared package: its own timer (a flag only the callback clears), and a helper that sets one. */
  let shared: {
    schedule(global: Record<string, unknown>): unknown
    later(global: Record<string, unknown>, fn: () => void): unknown
    path: string
  }

  before(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-window-timers-')))
    await mkdir(join(dir, 'node_modules/flag-package'), { recursive: true })
    await writeFile(
      join(dir, 'user.cjs'),
      [
        'exports.timer = (global) => global.setTimeout(() => {}, 5)',
        'exports.run = (fn, ...args) => fn(...args)',
        'exports.laterVia = (later, global) => later(global, () => {})',
        'exports.path = __filename',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(dir, 'node_modules/flag-package/index.js'),
      [
        'let running = false',
        'exports.schedule = (global) => {',
        '  running = true',
        '  return global.setTimeout(function flush() { running = false }, 0)',
        '}',
        'exports.later = (global, fn) => global.setTimeout(fn, 0)',
        'exports.path = __filename',
        '',
      ].join('\n'),
    )
    load = createRequire(join(dir, 'user.cjs'))
    user = load('./user.cjs')
    shared = load('flag-package')
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("cancels the file's own timer, and leaves one only Provino's code set (the coordinator's, in band)", () => {
    const { global, cleared, call } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    const files = user.timer(global)
    call('setTimeout', () => {}, 5)
    assert.deepEqual(stop(), [])
    assert.deepEqual(cleared, [files])
  })

  it("cancels a shared package's own timer that the file's code started, and names the package", () => {
    const { global, cleared } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    const handle = user.run(shared.schedule, global)
    assert.deepEqual(stop(), [shared.path], 'evaluated per file from then on')
    assert.deepEqual(cleared, [handle])
  })

  it('cancels a timer a shared package set with a callback the file handed it, naming nothing', () => {
    const { global, cleared } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    const handle = user.laterVia(shared.later, global)
    assert.deepEqual(stop(), [])
    assert.deepEqual(cleared, [handle])
  })

  it("leaves a shared package's timer that only Provino's code started", () => {
    const { global, cleared } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    shared.schedule(global)
    assert.deepEqual(stop(), [])
    assert.deepEqual(cleared, [])
  })

  it("takes every noted timer for the file's when its modules can't be read", () => {
    const { global, cleared, call } = standIn()
    const stop = installWindowTimers(global, {
      fileModules: () => {
        throw new Error('no file is running')
      },
    }).track()
    const handle = call('setTimeout', () => {}, 5)
    assert.deepEqual(stop(), [])
    assert.deepEqual(cleared, [handle])
  })

  it('reads the stack with its own formatter, whatever the process installed', () => {
    const { global, cleared } = standIn()
    const previous = Error.prepareStackTrace
    Error.prepareStackTrace = () => 'formatted by someone else'
    try {
      const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
      const handle = user.run(shared.schedule, global)
      assert.deepEqual(stop(), [shared.path])
      assert.deepEqual(cleared, [handle])
      assert.equal(Error.prepareStackTrace?.(new Error(), []), 'formatted by someone else')
    } finally {
      Error.prepareStackTrace = previous
    }
  })
})
