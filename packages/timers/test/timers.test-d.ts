// The public API of @provino/timers: the clock, its configuration, the timer members and misuse.
import {
  type AdvanceBy,
  createFakeClock,
  createTimerMembers,
  type FakeClock,
  type FakeClockOptions,
  type FakeMethod,
  type FakeTimersConfig,
  type SystemTime,
  type TimerMemberName,
  type TimerMembers,
  type TimersError,
  type TimersErrorCode,
  type TimerTickMode,
} from '@provino/timers'
import type { CurrentTest, TimersPolicy } from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const policy: TimersPolicy
declare const currentTest: CurrentTest

// The clock of an environment global.
const clock = createFakeClock(globalThis, policy)
expectTypeOf(clock).toEqualTypeOf<FakeClock>()
expectTypeOf(
  createFakeClock(globalThis, policy, { bind: currentTest.bind }),
).toEqualTypeOf<FakeClock>()
expectTypeOf<FakeClockOptions>().toEqualTypeOf<{
  readonly bind?: (<F extends (...args: never[]) => unknown>(fn: F) => F) | undefined
  readonly defaults?: FakeTimersConfig | undefined
}>()

// What each method takes and returns.
expectTypeOf(clock.install).parameters.toEqualTypeOf<[config?: FakeTimersConfig | undefined]>()
expectTypeOf(clock.advanceBy).parameters.toEqualTypeOf<[ms: AdvanceBy]>()
expectTypeOf(clock.advanceByAsync).returns.toEqualTypeOf<Promise<void>>()
expectTypeOf(clock.next).parameters.toEqualTypeOf<[steps?: number | undefined]>()
expectTypeOf(clock.count).returns.toBeNumber()
expectTypeOf(clock.isInstalled).returns.toBeBoolean()
expectTypeOf(clock.mockedSystemTime).returns.toEqualTypeOf<Date | null>()
expectTypeOf(clock.setSystemTime).parameters.toEqualTypeOf<[time?: SystemTime | undefined]>()
expectTypeOf(clock.setTickMode).parameters.toEqualTypeOf<[mode: TimerTickMode]>()
expectTypeOf<AdvanceBy>().toEqualTypeOf<
  number | { total(options: { unit: 'millisecond' }): number }
>()

// The configuration takes either runner's names, and `undefined` for a missing one.
clock.install({ doNotFake: ['nextTick'], advanceTimers: 20, timerLimit: 10 })
clock.install({ toFake: ['setTimeout'], shouldAdvanceTime: true, advanceTimeDelta: undefined })
clock.install({ now: new Date(0) })
clock.install({ now: { epochMilliseconds: 0 } })
clock.advanceBy({ total: () => 5 })
clock.setTickMode({ mode: 'interval', delta: 10 })
expectTypeOf<FakeMethod>().toEqualTypeOf<
  | 'setTimeout'
  | 'clearTimeout'
  | 'setImmediate'
  | 'clearImmediate'
  | 'setInterval'
  | 'clearInterval'
  | 'Date'
  | 'nextTick'
  | 'hrtime'
  | 'requestAnimationFrame'
  | 'cancelAnimationFrame'
  | 'requestIdleCallback'
  | 'cancelIdleCallback'
  | 'performance'
  | 'queueMicrotask'
  | 'Intl'
  | 'Temporal'
>()

// The timer members.
const members = createTimerMembers(
  () => clock,
  policy,
  () => ({}),
)
expectTypeOf(members).toEqualTypeOf<TimerMembers>()
expectTypeOf<keyof TimerMembers>().toEqualTypeOf<TimerMemberName>()

// The error and its codes.
declare const error: TimersError
expectTypeOf(error.code).toEqualTypeOf<TimersErrorCode>()
expectTypeOf<TimersErrorCode>().toEqualTypeOf<
  'TIMERS_NOT_FAKED' | 'TIMERS_LEGACY_UNSUPPORTED' | 'TIMERS_INVALID_TICK_MODE'
>()

// Misuse.
// @ts-expect-error a global the clock can't fake
clock.install({ doNotFake: ['setTimeoutt'] })
// @ts-expect-error the time is a number of milliseconds or a duration
clock.advanceBy('10')
// @ts-expect-error steps are a number
clock.next('2')
// @ts-expect-error a tick mode is manual, nextAsync or interval
clock.setTickMode({ mode: 'sideways' })
// @ts-expect-error `delta` belongs to the interval mode
clock.setTickMode({ mode: 'manual', delta: 5 })
// @ts-expect-error the loop limit is a number
clock.install({ timerLimit: '100' })
// @ts-expect-error the policy is the timers slice
createFakeClock(globalThis, { loopLimit: 1 })
// @ts-expect-error the members read the clock when they are called: it is a function, not a clock
createTimerMembers(clock, policy, () => ({}))
// @ts-expect-error a member the clock doesn't have
clock.runEverything()
