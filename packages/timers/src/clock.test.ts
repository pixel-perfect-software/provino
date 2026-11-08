import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, test } from 'node:test'
import type { TimersPolicy } from '@provino/types'
import { createFakeClock } from './clock.ts'
import { TimersError } from './errors.ts'
import { flipped, makeEnv, neutral } from './internal/test-support.ts'

const jestLike: TimersPolicy = {
  ...neutral,
  toFakeDefault: 'all',
  loopLimit: 100000,
  legacyAvailable: true,
  optionNames: 'do-not-fake',
  notFaked: 'warn',
  setSystemTimeWithoutFakes: 'warn-noop',
  advanceToNextTimerHonorsSteps: true,
  facadeReturns: 'lifecycle',
  messages: { notFaked: 'jest-like: timers are real.\nStack Trace:\n{stack}' },
}

const vitestLike: TimersPolicy = {
  ...neutral,
  advanceToNextTimerHonorsSteps: false,
  messages: { notFaked: 'vitest-like: timers are real.' },
}

describe('what install fakes', () => {
  test('the default set follows toFakeDefault', () => {
    for (const [policy, fakesMicrotasks] of [
      [jestLike, true],
      [vitestLike, false],
    ] as const) {
      const { env } = makeEnv()
      const real = { nextTick: env.process.nextTick, queueMicrotask: env.queueMicrotask }
      const realSetTimeout = env.setTimeout
      const clock = createFakeClock(env, policy)
      clock.install()
      assert.notEqual(env.setTimeout, realSetTimeout, 'setTimeout is faked')
      assert.equal(env.process.nextTick !== real.nextTick, fakesMicrotasks)
      assert.equal(env.queueMicrotask !== real.queueMicrotask, fakesMicrotasks)
      clock.uninstall()
      assert.equal(env.setTimeout, realSetTimeout, 'uninstall puts the real timer back')
    }
  })

  test('Jest names: doNotFake leaves a global real, and toFake is ignored', () => {
    const { env } = makeEnv()
    const realInterval = env.setInterval
    const clock = createFakeClock(env, jestLike)
    clock.install({ doNotFake: ['setInterval'], toFake: ['setImmediate'] })
    assert.equal(env.setInterval, realInterval)
    assert.notEqual(env.setTimeout, realInterval)
    assert.equal(clock.isInstalled(), true)
    clock.uninstall()
  })

  test('Vitest names: toFake fakes only those, and doNotFake is ignored', () => {
    const { env } = makeEnv()
    const realInterval = env.setInterval
    const realTimeout = env.setTimeout
    const clock = createFakeClock(env, vitestLike)
    clock.install({ toFake: ['setTimeout'], doNotFake: ['setTimeout'] })
    assert.equal(env.setInterval, realInterval)
    assert.notEqual(env.setTimeout, realTimeout)
    clock.uninstall()
  })

  test('Vitest names: toNotFake leaves those real and keeps the microtask queues real', () => {
    const { env } = makeEnv()
    const realNextTick = env.process.nextTick
    const realTimeout = env.setTimeout
    const clock = createFakeClock(env, vitestLike)
    clock.install({ toNotFake: ['setTimeout'] })
    assert.equal(env.setTimeout, realTimeout)
    assert.equal(env.process.nextTick, realNextTick)
    assert.notEqual(env.setInterval, setInterval)
    clock.uninstall()
  })

  test('a second install drops the pending timers', () => {
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    clock.install()
    env.setTimeout(() => {}, 10)
    assert.equal(clock.count(), 1)
    clock.install()
    assert.equal(clock.count(), 0)
    clock.uninstall()
  })

  test('the project defaults sit under the call', () => {
    const { env } = makeEnv()
    const realInterval = env.setInterval
    const clock = createFakeClock(env, jestLike, { defaults: { doNotFake: ['setInterval'] } })
    clock.install()
    assert.equal(env.setInterval, realInterval)
    clock.install({ doNotFake: [] })
    assert.notEqual(env.setInterval, realInterval)
    clock.uninstall()
  })

  test('legacy timers are unsupported where the policy has them, and ignored where it has none', () => {
    const { env } = makeEnv()
    const jestClock = createFakeClock(env, jestLike)
    assert.throws(
      () => jestClock.install({ legacyFakeTimers: true }),
      (error) => error instanceof TimersError && error.code === 'TIMERS_LEGACY_UNSUPPORTED',
    )
    assert.equal(jestClock.isInstalled(), false)
    const vitestClock = createFakeClock(env, vitestLike)
    vitestClock.install({ legacyFakeTimers: true })
    assert.equal(vitestClock.isInstalled(), true)
    vitestClock.uninstall()
  })
})

describe('advancing', () => {
  test('advanceBy fires the timers that are due, in order', () => {
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    clock.install()
    const fired: number[] = []
    for (const ms of [30, 10, 20]) env.setTimeout(() => fired.push(ms), ms)
    clock.advanceBy(15)
    assert.deepEqual(fired, [10])
    clock.advanceBy({ total: () => 20 })
    assert.deepEqual(fired, [10, 20, 30])
    clock.uninstall()
  })

  test('next honours steps only where the policy says so', () => {
    for (const [policy, expected] of [
      [jestLike, [10, 20]],
      [vitestLike, [10]],
    ] as const) {
      const { env } = makeEnv()
      const clock = createFakeClock(env, policy)
      clock.install()
      const fired: number[] = []
      for (const ms of [10, 20, 30]) env.setTimeout(() => fired.push(ms), ms)
      clock.next(2)
      assert.deepEqual(fired, expected)
      clock.uninstall()
    }
  })

  test('runAll stops at the policy loop limit', () => {
    for (const [policy, limit] of [
      [jestLike, 100000],
      [vitestLike, 10000],
    ] as const) {
      const { env } = makeEnv()
      const clock = createFakeClock(env, policy)
      clock.install()
      const loop = (): void => void env.setTimeout(loop, 1)
      loop()
      assert.throws(() => clock.runAll(), new RegExp(`after running ${limit} timers`))
      clock.uninstall()
    }
  })

  test('timerLimit and loopLimit replace the policy limit under their own names', () => {
    const { env } = makeEnv()
    const jest = createFakeClock(env, jestLike)
    jest.install({ timerLimit: 5, loopLimit: 7 })
    const loop = (): void => void env.setTimeout(loop, 1)
    loop()
    assert.throws(() => jest.runAll(), /after running 5 timers/)
    jest.uninstall()
    const vitest = createFakeClock(env, vitestLike)
    vitest.install({ loopLimit: 7, timerLimit: 5 })
    loop()
    assert.throws(() => vitest.runAll(), /after running 7 timers/)
    vitest.uninstall()
  })

  test('the async forms flush promise jobs between timers, the sync ones do not', async () => {
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    clock.install()
    const log: string[] = []
    env.setTimeout(() => {
      log.push('timer 1')
      void Promise.resolve().then(() => log.push('job after 1'))
    }, 10)
    env.setTimeout(() => log.push('timer 2'), 20)
    await clock.advanceByAsync(20)
    assert.deepEqual(log, ['timer 1', 'job after 1', 'timer 2'])
    log.length = 0
    env.setTimeout(() => {
      log.push('timer 1')
      void Promise.resolve().then(() => log.push('job after 1'))
    }, 10)
    env.setTimeout(() => log.push('timer 2'), 20)
    clock.advanceBy(20)
    assert.deepEqual(log, ['timer 1', 'timer 2'])
    await Promise.resolve()
    assert.deepEqual(log, ['timer 1', 'timer 2', 'job after 1'])
    clock.uninstall()
  })

  test('nextFrame moves to the next 16 ms frame', () => {
    const { env } = makeEnv({ requestAnimationFrame: (): number => 0 })
    const clock = createFakeClock(env, jestLike)
    clock.install({ now: 0 })
    const times: number[] = []
    const raf = env.requestAnimationFrame as (callback: (time: number) => void) => number
    raf((time) => times.push(time))
    clock.nextFrame()
    assert.equal(clock.now(), 16)
    assert.equal(times.length, 1)
    clock.uninstall()
  })

  test('runMicrotasks flushes the faked queues, and is a no-op where they are real', () => {
    for (const [policy, ran] of [
      [jestLike, true],
      [vitestLike, false],
    ] as const) {
      const { env } = makeEnv()
      const clock = createFakeClock(env, policy)
      clock.install()
      let called = false
      env.process.nextTick(() => {
        called = true
      })
      clock.runMicrotasks()
      assert.equal(called, ran)
      clock.uninstall()
    }
  })

  test('clearAll drops every timer and the time with them; reset keeps the time', () => {
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    clock.install({ now: 1000 })
    env.setTimeout(() => {}, 10)
    clock.advanceBy(5)
    clock.clearAll()
    assert.equal(clock.count(), 0)
    assert.equal(clock.now(), 1000, 'sinon`s reset also puts the time back to the install time')
    clock.advanceBy(5)
    env.setTimeout(() => {}, 10)
    clock.reset()
    assert.equal(clock.count(), 0)
    assert.equal(clock.now(), 1005)
    clock.uninstall()
  })

  test('setTickMode takes sinon-style modes and refuses others', () => {
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    clock.install()
    clock.setTickMode({ mode: 'manual' })
    clock.setTickMode({ mode: 'nextAsync' })
    clock.setTickMode({ mode: 'interval', delta: 10 })
    assert.throws(
      () => clock.setTickMode({ mode: 'sideways' } as never),
      (error) => error instanceof TimersError && error.code === 'TIMERS_INVALID_TICK_MODE',
    )
    clock.uninstall()
  })
})

describe('timers that are real', () => {
  test('notFaked warns with the policy text and carries on', () => {
    const { env, warnings } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    clock.advanceBy(1)
    clock.runAll()
    assert.equal(clock.count(), 0)
    assert.equal(warnings.length, 3)
    assert.match(warnings[0] ?? '', /^jest-like: timers are real\.\nStack Trace:\n\s+at /)
    assert.doesNotMatch(warnings[0] ?? '', /\{stack\}/)
  })

  test('notFaked throws with the policy text', () => {
    const { env, warnings } = makeEnv()
    const clock = createFakeClock(env, vitestLike)
    assert.throws(
      () => clock.advanceBy(1),
      (error) =>
        error instanceof TimersError &&
        error.code === 'TIMERS_NOT_FAKED' &&
        error.message === 'vitest-like: timers are real.',
    )
    assert.throws(() => clock.count(), TimersError)
    assert.deepEqual(warnings, [])
  })

  test('clearAll and uninstall are quiet', () => {
    const { env, warnings } = makeEnv()
    const clock = createFakeClock(env, vitestLike)
    clock.clearAll()
    clock.uninstall()
    clock.dispose()
    assert.deepEqual(warnings, [])
  })

  test('setSystemTime warns and does nothing under warn-noop', () => {
    const { env, warnings } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    const before = env.Date.now()
    clock.setSystemTime(0)
    assert.equal(warnings.length, 1)
    assert.ok(env.Date.now() >= before)
    assert.equal(clock.mockedSystemTime(), null)
  })

  test('setSystemTime fakes Date alone under fake-date-only, and useRealTimers ends it', () => {
    const { env, warnings } = makeEnv()
    const realTimeout = env.setTimeout
    const clock = createFakeClock(env, vitestLike)
    clock.setSystemTime(0)
    assert.equal(env.Date.now(), 0)
    assert.equal(env.setTimeout, realTimeout, 'the timers stay real')
    assert.equal(clock.isInstalled(), false)
    assert.equal(clock.mockedSystemTime()?.getTime(), 0)
    clock.setSystemTime(5000)
    assert.equal(env.Date.now(), 5000)
    assert.deepEqual(warnings, [])
    clock.uninstall()
    assert.ok(env.Date.now() > 1_000_000)
    assert.equal(clock.mockedSystemTime(), null)
  })

  test('install after fake-date-only starts from that date and fakes everything', () => {
    const { env } = makeEnv()
    const clock = createFakeClock(env, vitestLike)
    clock.setSystemTime(4000)
    clock.install()
    assert.equal(clock.now(), 4000)
    assert.equal(clock.isInstalled(), true)
    clock.uninstall()
  })

  test('now and getRealSystemTime read the real clock while timers are real', () => {
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    assert.ok(Math.abs(clock.now() - Date.now()) < 1000)
    clock.install({ now: 123 })
    assert.equal(clock.now(), 123)
    assert.ok(Math.abs(clock.getRealSystemTime() - Date.now()) < 1000)
    clock.uninstall()
  })
})

describe('Temporal', () => {
  const temporal = (): object => {
    class Instant {
      readonly epochNanoseconds: bigint
      constructor(epochNanoseconds: bigint) {
        this.epochNanoseconds = epochNanoseconds
      }
      static fromEpochNanoseconds(value: bigint): Instant {
        return new Instant(value)
      }
      static fromEpochMilliseconds(value: number): Instant {
        return new Instant(BigInt(value) * 1_000_000n)
      }
    }
    return {
      Temporal: {
        Instant,
        Now: { instant: (): Instant => new Instant(0n), timeZoneId: (): string => 'UTC' },
      },
    }
  }

  test('fakeTemporal puts Temporal in the default set', () => {
    for (const [fakeTemporal, faked] of [
      [true, true],
      [false, false],
    ] as const) {
      const { env } = makeEnv(temporal())
      const native = env.Temporal
      const clock = createFakeClock(env, { ...jestLike, fakeTemporal })
      clock.install()
      assert.equal(env.Temporal !== native, faked)
      clock.uninstall()
      assert.equal(env.Temporal, native)
    }
  })

  test('fakeTemporal puts Temporal in the Date-only set', () => {
    for (const [fakeTemporal, faked] of [
      [true, true],
      [false, false],
    ] as const) {
      const { env } = makeEnv(temporal())
      const native = env.Temporal
      const clock = createFakeClock(env, { ...vitestLike, fakeTemporal })
      clock.setSystemTime(0)
      assert.equal(env.Temporal !== native, faked)
      clock.uninstall()
    }
  })
})

describe('the async context', () => {
  test('a callback fires in the context it was scheduled in', () => {
    const storage = new AsyncLocalStorage<string>()
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike, { bind: (fn) => AsyncLocalStorage.bind(fn) })
    clock.install()
    const seen: Array<string | undefined> = []
    storage.run('first', () => {
      env.setTimeout(() => seen.push(storage.getStore()), 10)
      env.setInterval(() => seen.push(storage.getStore()), 30)
      env.process.nextTick(() => seen.push(storage.getStore()))
    })
    storage.run('second', () => {
      env.setTimeout(() => seen.push(storage.getStore()), 20)
      clock.advanceBy(10)
    })
    clock.advanceBy(30)
    assert.deepEqual(seen, ['first', 'first', 'second', 'first'])
    clock.uninstall()
  })

  test('without bind a callback runs in the context of the call that fires it', () => {
    const storage = new AsyncLocalStorage<string>()
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike)
    clock.install()
    let seen: string | undefined
    storage.run('first', () => {
      env.setTimeout(() => {
        seen = storage.getStore()
      }, 10)
    })
    storage.run('ticker', () => clock.advanceBy(10))
    assert.equal(seen, 'ticker')
    clock.uninstall()
  })

  test('the wrapper keeps the fake timer`s own properties', () => {
    const { env } = makeEnv()
    const clock = createFakeClock(env, jestLike, { bind: (fn) => AsyncLocalStorage.bind(fn) })
    clock.install()
    assert.ok('clock' in env.setTimeout)
    assert.equal(typeof env.clearTimeout, 'function')
    const id = env.setTimeout(() => assert.fail('cleared'), 10)
    env.clearTimeout(id)
    clock.advanceBy(10)
    clock.uninstall()
  })
})

describe('the flipped policy', () => {
  test('every key reads as its own value', () => {
    const { env, warnings } = makeEnv()
    const clock = createFakeClock(env, flipped)
    clock.advanceBy(1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /^flipped: timers are real\.\nStack Trace:\n/)
  })
})
