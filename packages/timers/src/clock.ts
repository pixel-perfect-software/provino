// The fake clock (Track 4, T4.9): one class over `@sinonjs/fake-timers` 15.4 that Jest's
// `ModernFakeTimers` and Vitest 5.0's `FakeTimers` are both thin wrappers of. What differs between
// them is a `TimersPolicy` value: the default set, the option names, the loop limit, what an
// advance call does while timers are real, what `setSystemTime` does then, whether `next` honours
// its steps. Rebuilt from `@jest/fake-timers` 30.5.2 `modernFakeTimers.ts` and Vitest 5.0.5
// `integrations/mock/timers.ts`; each rule below names the one it follows.

import type { TimersPolicy } from '@provino/types'
import {
  type Clock,
  type Config,
  type FakeMethod as SinonMethod,
  withGlobal,
} from '@sinonjs/fake-timers'
import { TimersError } from './errors.ts'
import type {
  AdvanceBy,
  FakeClock,
  FakeClockOptions,
  FakeMethod,
  FakeTimersConfig,
  SystemTime,
  TimerTickMode,
} from './types.ts'

/** The globals that queue a callback to run later: the ones a callback is bound to its test at. */
const SCHEDULERS = [
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  'requestIdleCallback',
  'queueMicrotask',
] as const

/** Node's own microtask-ish queues, left real by default under `toFakeDefault: 'all-but-microtasks'`. */
const MICROTASKS: ReadonlySet<string> = new Set(['nextTick', 'queueMicrotask'])

/** The part of an environment global the clock reads. */
type EnvGlobal = typeof globalThis

/**
 * Creates the clock for one environment global. `withGlobal` reads which timers the global has
 * (`Temporal`, `requestAnimationFrame`, ...) when it is called, so the global must be complete by
 * now. Timers are real until `install`.
 * @public
 */
export function createFakeClock(
  env: object,
  policy: TimersPolicy,
  options: FakeClockOptions = {},
): FakeClock {
  const global = env as EnvGlobal
  const sinon = withGlobal(global)
  const allMethods = Object.keys(sinon.timers) as FakeMethod[]
  // Captured now, while `Date` is real: `getRealSystemTime` is `Date.now()` as the module saw it.
  const RealDate = global.Date
  const realNow = RealDate.now.bind(RealDate)

  let installed: Clock | null = null
  // Vitest's `_fakingDate`: set by `setSystemTime` while timers are real (`fake-date-only`).
  let dateOnly: Date | null = null
  // The clock that fakes `Date` alone is also a sinon clock; `clock` is whichever is installed.
  let clock: Clock | null = null

  const defaultMethods = (): FakeMethod[] =>
    allMethods.filter(
      (method) =>
        (policy.fakeTemporal || method !== 'Temporal') &&
        (policy.toFakeDefault === 'all' || !MICROTASKS.has(method)),
    )

  /** Jest's `_toSinonFakeTimersConfig` (`do-not-fake`) or Vitest's `useFakeTimers` (`to-fake`). */
  function toSinonConfig(config: FakeTimersConfig, now: Date | number): Config {
    if (policy.optionNames === 'do-not-fake') {
      const skip = new Set<string>(config.doNotFake ?? [])
      return {
        ...(typeof config.advanceTimers === 'number'
          ? { advanceTimeDelta: config.advanceTimers }
          : {}),
        ignoreMissingTimers: true,
        loopLimit: config.timerLimit || policy.loopLimit,
        now: config.now ?? now,
        shouldAdvanceTime: Boolean(config.advanceTimers),
        shouldClearNativeTimers: true,
        toFake: defaultMethods().filter((method) => !skip.has(method)) as SinonMethod[],
      }
    }
    let toFake: FakeMethod[]
    if (config.toFake !== undefined) {
      toFake = [...config.toFake]
    } else if (config.toNotFake !== undefined) {
      // Vitest adds the microtask queues to `toNotFake` unless `toFakeDefault` fakes them.
      const skip = new Set<string>(config.toNotFake)
      if (policy.toFakeDefault === 'all-but-microtasks')
        for (const name of MICROTASKS) skip.add(name)
      toFake = defaultMethods().filter((method) => !skip.has(method))
    } else {
      toFake = defaultMethods()
    }
    return {
      ...(config.advanceTimeDelta === undefined
        ? {}
        : { advanceTimeDelta: config.advanceTimeDelta }),
      ignoreMissingTimers: true,
      loopLimit: config.loopLimit ?? policy.loopLimit,
      now: config.now ?? now,
      ...(config.shouldAdvanceTime === undefined
        ? {}
        : { shouldAdvanceTime: config.shouldAdvanceTime }),
      shouldClearNativeTimers: config.shouldClearNativeTimers ?? true,
      toFake: toFake as SinonMethod[],
    }
  }

  /**
   * Binds every callback the faked schedulers take to the async context it was scheduled in
   * (§6 L793): a fake timer fires from `tick()`, in the caller of `tick()`, where the real one
   * fires in the context of its `setTimeout`. The wrapper keeps the fake's own properties
   * (`.clock`, `util.promisify.custom`), so what looks at them still finds them.
   */
  function bindSchedulers(faked: Clock): void {
    const { bind } = options
    if (bind === undefined) return
    const faking = new Set<string>(faked.methods)
    const wrap = (target: Record<string, unknown>, name: string): void => {
      const fake = target[name]
      if (typeof fake !== 'function') return
      const wrapper = function (this: unknown, callback: unknown, ...rest: unknown[]): unknown {
        return Reflect.apply(fake, this, [
          typeof callback === 'function' ? bind(callback as () => unknown) : callback,
          ...rest,
        ])
      }
      for (const key of Reflect.ownKeys(fake)) {
        if (key === 'length' || key === 'name' || key === 'prototype') continue
        const descriptor = Object.getOwnPropertyDescriptor(fake, key)
        if (descriptor !== undefined) Object.defineProperty(wrapper, key, descriptor)
      }
      target[name] = wrapper
    }
    for (const name of SCHEDULERS) {
      if (faking.has(name)) wrap(global as unknown as Record<string, unknown>, name)
    }
    if (faking.has('nextTick') && global.process !== undefined) {
      wrap(global.process as unknown as Record<string, unknown>, 'nextTick')
    }
  }

  function uninstallClock(): void {
    if (clock !== null) clock.uninstall()
    clock = null
    installed = null
    dateOnly = null
  }

  /** The stack of the call, from the frame above `from` on. */
  function callerStack(from: () => unknown): string {
    const error = new Error()
    Error.captureStackTrace(error, from)
    return (error.stack ?? '').split('\n').slice(1).join('\n')
  }

  function notFakedText(from: () => unknown): string {
    return policy.messages.notFaked.replace('{stack}', () => callerStack(from))
  }

  /** Jest's `_checkFakeTimers` and Vitest's: warn and carry on, or throw. */
  function check(): boolean {
    if (installed !== null) return true
    if (policy.notFaked === 'throw') throw new TimersError('TIMERS_NOT_FAKED', notFakedText(check))
    global.console.warn(notFakedText(check))
    return false
  }

  const live = (): Clock => installed as Clock

  const milliseconds = (ms: AdvanceBy): number =>
    typeof ms === 'number' ? ms : ms.total({ unit: 'millisecond' })

  const timeOf = (time: SystemTime | undefined): Date | undefined =>
    time === undefined
      ? undefined
      : time instanceof Date
        ? time
        : new Date(typeof time === 'number' ? time : time.epochMilliseconds)

  const self: FakeClock = {
    install(config = {}) {
      const merged: FakeTimersConfig = { ...options.defaults, ...config }
      if (policy.legacyAvailable && merged.legacyFakeTimers === true) {
        throw new TimersError(
          'TIMERS_LEGACY_UNSUPPORTED',
          'Provino does not implement legacy fake timers (`legacyFakeTimers: true`). Use the modern fake timers: drop the option, or `doNotFake` the globals you need real.',
        )
      }
      // Vitest keeps a `Date`-only time across the call; a pending timer never survives it.
      const fakeDate = dateOnly ?? realNow()
      uninstallClock()
      clock = sinon.install(toSinonConfig(merged, fakeDate))
      installed = clock
      bindSchedulers(clock)
    },

    uninstall() {
      uninstallClock()
    },

    dispose() {
      uninstallClock()
    },

    isInstalled() {
      return installed !== null
    },

    advanceBy(ms) {
      if (check()) live().tick(milliseconds(ms))
    },

    async advanceByAsync(ms) {
      if (check()) await live().tickAsync(milliseconds(ms))
    },

    next(steps = 1) {
      if (!check()) return
      const count = policy.advanceToNextTimerHonorsSteps ? steps : 1
      for (let step = count; step > 0; step--) {
        live().next()
        // Fire all timers at this point: https://github.com/sinonjs/fake-timers/issues/250
        live().tick(0)
        if (live().countTimers() === 0) break
      }
    },

    async nextAsync(steps = 1) {
      if (!check()) return
      const count = policy.advanceToNextTimerHonorsSteps ? steps : 1
      for (let step = count; step > 0; step--) {
        await live().nextAsync()
        await live().tickAsync(0)
        if (live().countTimers() === 0) break
      }
    },

    nextFrame() {
      if (check()) live().runToFrame()
    },

    runAll() {
      if (check()) live().runAll()
    },

    async runAllAsync() {
      if (check()) await live().runAllAsync()
    },

    runPending() {
      if (check()) live().runToLast()
    },

    async runPendingAsync() {
      if (check()) await live().runToLastAsync()
    },

    runMicrotasks() {
      if (check()) live().runMicrotasks()
    },

    clearAll() {
      if (installed !== null) installed.reset()
    },

    count() {
      return check() ? live().countTimers() : 0
    },

    reset() {
      if (!check()) return
      const { now } = live()
      live().reset()
      live().setSystemTime(now)
    },

    setSystemTime(time) {
      if (installed !== null) {
        installed.setSystemTime(timeOf(time))
        return
      }
      if (policy.setSystemTimeWithoutFakes === 'warn-noop') {
        global.console.warn(notFakedText(self.setSystemTime))
        return
      }
      const date = timeOf(time) ?? new Date(realNow())
      if (dateOnly !== null && clock !== null) {
        dateOnly = date
        clock.setSystemTime(date)
        return
      }
      dateOnly = date
      clock = sinon.install({
        ignoreMissingTimers: true,
        now: date,
        toFake: (policy.fakeTemporal ? ['Date', 'Temporal'] : ['Date']) as SinonMethod[],
      })
    },

    mockedSystemTime() {
      return installed !== null ? new Date(installed.now) : dateOnly
    },

    getRealSystemTime() {
      return realNow()
    },

    now() {
      return installed !== null ? installed.now : realNow()
    },

    setTickMode(mode: TimerTickMode) {
      if (!check()) return
      if (mode.mode === 'manual' || mode.mode === 'nextAsync') {
        live().setTickMode({ mode: mode.mode })
      } else if (mode.mode === 'interval') {
        live().setTickMode(
          mode.delta === undefined ? { mode: 'interval' } : { mode: 'interval', delta: mode.delta },
        )
      } else {
        throw new TimersError(
          'TIMERS_INVALID_TICK_MODE',
          `Invalid tick mode: ${String((mode as { mode: unknown }).mode)}`,
        )
      }
    },
  }
  return self
}
