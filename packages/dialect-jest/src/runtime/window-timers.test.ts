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
import { USER_CALL_FRAME } from '@provino/core'
import { installWindowTimers } from './window-timers.ts'

/**
 * Calls `fn` as core calls a test's or hook's function: through a frame of Provino's own code (this
 * file is inside Provino's packages) named `USER_CALL_FRAME`.
 */
const viaCore = {
  [USER_CALL_FRAME]<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): unknown {
    return fn(...args)
  },
}[USER_CALL_FRAME]

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
  /** Another of the file's modules, one the registry loads after the file's modules were read. */
  let late: { timer(global: Record<string, unknown>, fn: () => void): unknown; path: string }
  /**
   * The file's own module: sets a timer, calls the package, hands it a callback, and sets a timer
   * whose callback (its own code) calls the function it is given.
   */
  let user: {
    timer(global: Record<string, unknown>): unknown
    run<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): unknown
    laterVia(later: typeof shared.later, global: Record<string, unknown>): unknown
    soon(global: Record<string, unknown>, fn: (global: Record<string, unknown>) => unknown): unknown
    path: string
  }
  /**
   * A shared package: its own timer (a flag only the callback clears), a helper that sets one, a
   * loop that sets its next timer from its own callback (as a scheduler does), an interval whose
   * every run sets a timer, a timer whose callback sets one from a promise continuation, and an
   * unmount that destroys on a later tick (as @tiptap/react's does), called from a hook.
   */
  let shared: {
    schedule(global: Record<string, unknown>): unknown
    later(global: Record<string, unknown>, fn: () => void): unknown
    loop(global: Record<string, unknown>): unknown
    every(global: Record<string, unknown>): unknown
    settle(global: Record<string, unknown>): unknown
    unmount(global: Record<string, unknown>): unknown
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
        'exports.soon = (global, fn) => global.setTimeout(() => fn(global), 1)',
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
        'exports.loop = (global) => global.setTimeout(function slice() { global.setTimeout(slice, 0) }, 0)',
        'exports.every = (global) => global.setInterval(function tick() { global.setTimeout(function after() {}, 0) }, 10)',
        'exports.settle = (global) => global.setTimeout(function settle() {',
        '  return Promise.resolve().then(function later() { global.setTimeout(function late() {}, 0) })',
        '}, 0)',
        'exports.unmount = (global) => global.setTimeout(function destroy() {}, 1)',
        'exports.path = __filename',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(dir, 'late.cjs'),
      [
        'exports.timer = (global, fn) => global.setTimeout(fn, 0)',
        'exports.path = __filename',
        '',
      ].join('\n'),
    )
    load = createRequire(join(dir, 'user.cjs'))
    user = load('./user.cjs')
    shared = load('flag-package')
    late = load('./late.cjs')
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

  it("cancels a shared package's timer set from a hook core calls, a shared package's own hook too, and names the package", () => {
    const { global, cleared } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    // A hook a shared package registered as it loaded (@testing-library/react's auto cleanup, Node's
    // copy in a worker's first file), whose unmount sets the timer: no frame of the file's is on
    // the stack, only core's call of the hook, Provino's frame with the name a stack walk knows.
    const handle = viaCore(shared.unmount, global)
    assert.deepEqual(stop(), [shared.path], 'evaluated per file from then on')
    assert.deepEqual(cleared, [handle])
  })

  it("leaves a timer Provino's own hook sets when core calls it", () => {
    const { global, cleared, call } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    // The hook is this test's code, Provino's (as the dialect's own afterEach is): its frame comes
    // before core's, so it decides.
    viaCore(() => call('setTimeout', () => {}, 1))
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

  it("cancels the timer a shared package's loop set from its own callback, and names the package", () => {
    const { global, cleared, scheduled, fire } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    user.run(shared.loop, global)
    for (let slice = 0; slice < 3; slice++) {
      const pending = scheduled.at(-1)
      assert.ok(pending !== undefined)
      fire(pending)
    }
    assert.equal(scheduled.length, 4, 'each slice set the next')
    assert.deepEqual(stop(), [shared.path], 'the first slice was the file’s, so every later one is')
    assert.deepEqual(cleared, [scheduled[3]], 'only the one still pending')
  })

  it("names the shared package that set a timer inside the callback of the file's own timer", () => {
    const { global, cleared, scheduled, fire } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    const outer = user.soon(global, shared.schedule)
    fire(outer as Parameters<typeof fire>[0])
    assert.equal(scheduled.length, 2, 'the callback set the package’s timer')
    assert.deepEqual(stop(), [shared.path], 'its flag is stuck, so it goes per file')
    assert.deepEqual(cleared, [scheduled[1]])
  })

  it("leaves a timer Provino's code sets inside the callback of the file's own timer", () => {
    const { global, cleared, scheduled, fire } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    const set = global.setTimeout as (fn: () => void, delay: number) => unknown
    // The callback is this test's code, Provino's (as the loader's parser is, reached from a lazy
    // `require`): its frame lies between the shared package's and the wrapper's.
    const outer = user.run(set, () => shared.schedule(global), 1)
    fire(outer as Parameters<typeof fire>[0])
    assert.equal(scheduled.length, 2, 'the callback set the package’s timer')
    assert.deepEqual(stop(), [])
    assert.deepEqual(cleared, [], 'the outer timer fired, and the inner one is not the file’s')
  })

  it("reads the file's modules again for a timer set from a module loaded after the last read", () => {
    const { global, cleared, scheduled, fire } = standIn()
    const modules = [user.path]
    const stop = installWindowTimers(global, { fileModules: () => modules }).track()
    user.run(shared.loop, global)
    const slice = scheduled[0]
    assert.ok(slice !== undefined)
    fire(slice) // the file's modules are read for the slice it sets
    modules.push(late.path)
    // A bound callback leaves no frame of its own: the loop's timer is set by the package alone,
    // inside the late module's timer, whose verdict needs the late module among the file's.
    const outer = late.timer(global, shared.loop.bind(null, global))
    fire(outer as Parameters<typeof fire>[0])
    assert.deepEqual(stop(), [shared.path])
    assert.deepEqual(cleared, [scheduled[1], scheduled[3]], "the late module's timer set the last")
  })

  it("leaves a timer set from the callback of a timer that is not the file's", () => {
    const { global, cleared, scheduled, call, fire } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    // Set here, in Provino's own code (as the coordinator's are, in band): not the file's.
    const outer = call('setTimeout', () => shared.loop(global), 1)
    fire(outer)
    const loop = scheduled[1]
    assert.ok(loop !== undefined)
    fire(loop)
    assert.deepEqual(stop(), [])
    assert.deepEqual(cleared, [], 'nothing the file started is pending')
  })

  it("still takes a timer the file's own code sets from a callback that is not the file's", () => {
    const { global, cleared, scheduled, call, fire } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    const outer = call('setTimeout', () => user.timer(global), 1)
    fire(outer)
    assert.deepEqual(stop(), [])
    assert.deepEqual(cleared, [scheduled[1]], "the stack is read: the file's frame set it")
  })

  it('notes an interval once however often it runs, and cancels what each run set', () => {
    const { global, cleared, scheduled, fire } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    const interval = user.run(shared.every, global)
    const first = scheduled[0]
    assert.ok(first !== undefined && first === interval)
    fire(first)
    fire(first)
    assert.deepEqual(stop(), [shared.path])
    assert.deepEqual(cleared, [interval, scheduled[1], scheduled[2]], 'each cancelled once')
  })

  it('reads a timer set from a promise continuation inside a callback from its own stack', async () => {
    const { global, cleared, scheduled, fire } = standIn()
    const stop = installWindowTimers(global, { fileModules: () => [user.path] }).track()
    const first = scheduled.length
    user.run(shared.settle, global)
    const settle = scheduled[first]
    assert.ok(settle !== undefined)
    await fire(settle)
    assert.equal(scheduled.length, first + 2, 'the continuation set a timer')
    // The continuation runs after the callback's synchronous part, so no running timer's verdict
    // applies (the first timer's, the file's, would cancel it): its own stack decides, and here its
    // async frames reach this test's, Provino's code.
    assert.deepEqual(stop(), [])
    assert.deepEqual(cleared, [])
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
