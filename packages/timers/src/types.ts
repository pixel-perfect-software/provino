// The public types of @provino/timers: the clock, its configuration and the timer members.

/**
 * A global the clock can replace: the names `@sinonjs/fake-timers` 15.4 takes.
 * @public
 */
export type FakeMethod =
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

/**
 * A `Temporal.Instant` or `Temporal.ZonedDateTime`, as far as the clock reads one.
 * @public
 */
export interface TemporalTimelike {
  readonly epochMilliseconds: number
}

/**
 * A `Temporal.Duration`, as far as the clock reads one.
 * @public
 */
export interface TemporalDurationLike {
  total(options: { unit: 'millisecond' }): number
}

/**
 * What `install` takes. A dialect's `optionNames` (`TimersPolicy`) picks which half is read: Jest's
 * `fakeTimers` names (`doNotFake`, `advanceTimers`, `timerLimit`, `legacyFakeTimers`) or Vitest's
 * (`toFake`, `toNotFake`, `shouldAdvanceTime`, `advanceTimeDelta`, `loopLimit`,
 * `shouldClearNativeTimers`). The other half is ignored, as each runner ignores the other's names.
 * `now` is read under both.
 * @public
 */
export interface FakeTimersConfig {
  readonly now?: number | Date | TemporalTimelike | undefined
  /** Jest: globals to leave real. */
  readonly doNotFake?: readonly FakeMethod[] | undefined
  /** Jest: advance the clock with real time, every 20 ms or the given number of ms. */
  readonly advanceTimers?: boolean | number | undefined
  /** Jest: how many timers `runAllTimers` runs before it gives up. */
  readonly timerLimit?: number | undefined
  /** Jest: ask for the legacy implementation, which Provino doesn't have. */
  readonly legacyFakeTimers?: boolean | undefined
  /** Vitest: the globals to fake. */
  readonly toFake?: readonly FakeMethod[] | undefined
  /** Vitest: the globals to leave real. */
  readonly toNotFake?: readonly FakeMethod[] | undefined
  /** Vitest: advance the clock with real time. */
  readonly shouldAdvanceTime?: boolean | undefined
  /** Vitest: the step of that advance in ms (default 20). */
  readonly advanceTimeDelta?: number | undefined
  /** Vitest: how many timers `runAllTimers` runs before it gives up. */
  readonly loopLimit?: number | undefined
  /** Vitest: whether a native timer id passed to a fake `clearTimeout` is cleared (default `true`). */
  readonly shouldClearNativeTimers?: boolean | undefined
}

/**
 * How the clock moves without being told to.
 * @public
 */
export type TimerTickMode =
  | { readonly mode: 'manual' | 'nextAsync' }
  | { readonly mode: 'interval'; readonly delta?: number | undefined }

/**
 * A duration in ms, or a `Temporal.Duration`.
 * @public
 */
export type AdvanceBy = number | TemporalDurationLike

/**
 * What `setSystemTime` takes.
 * @public
 */
export type SystemTime = number | Date | TemporalTimelike

/**
 * The fake clock of one environment global (Track 4 `FakeClock`). Every difference between Jest's
 * and Vitest's timers is a `TimersPolicy` value; there is one implementation.
 * @public
 */
export interface FakeClock {
  /**
   * Fakes the environment's timers. A second call drops the pending timers first. With
   * `legacyAvailable`, `legacyFakeTimers: true` throws `TIMERS_LEGACY_UNSUPPORTED`.
   */
  install(config?: FakeTimersConfig): void
  /** Puts the real timers back. Does nothing when they are. */
  uninstall(): void
  /** Same as `uninstall`: the clock is spent. */
  dispose(): void
  /** Whether the timers are faked (a clock that only fakes `Date` is not). */
  isInstalled(): boolean
  /** `advanceTimersByTime`. */
  advanceBy(ms: AdvanceBy): void
  advanceByAsync(ms: AdvanceBy): Promise<void>
  /** `advanceTimersToNextTimer`: `steps` timers when the policy honours them, else one. */
  next(steps?: number): void
  nextAsync(steps?: number): Promise<void>
  /** `advanceTimersToNextFrame`: to the next 16 ms frame. */
  nextFrame(): void
  /** `runAllTimers`. */
  runAll(): void
  runAllAsync(): Promise<void>
  /** `runOnlyPendingTimers`. */
  runPending(): void
  runPendingAsync(): Promise<void>
  /** `runAllTicks`: the jobs a faked `nextTick` or `queueMicrotask` queued. */
  runMicrotasks(): void
  /** `clearAllTimers`. */
  clearAll(): void
  /** `getTimerCount`. */
  count(): number
  /** Drops every timer and keeps the time. */
  reset(): void
  /**
   * `setSystemTime`. While timers are real it warns and does nothing (`warn-noop`) or fakes `Date`
   * (and `Temporal`) alone (`fake-date-only`).
   */
  setSystemTime(time?: SystemTime): void
  /** The time `setSystemTime` or `install` set, or `null` when `Date` is real. */
  mockedSystemTime(): Date | null
  /** `Date.now()` as it was before any install. */
  getRealSystemTime(): number
  /** The fake time while timers are faked, else the real one. */
  now(): number
  setTickMode(mode: TimerTickMode): void
}

/**
 * What `createFakeClock` takes besides the environment and the policy.
 * @public
 */
export interface FakeClockOptions {
  /**
   * Binds a callback to the async context it is scheduled in, so one that a later `advance` call
   * fires runs as the test that scheduled it (`CurrentTest.bind`). Without it, a callback runs in
   * its caller's context.
   */
  readonly bind?: (<F extends (...args: never[]) => unknown>(fn: F) => F) | undefined
  /** The project's `fakeTimers` configuration: what a call's own config is layered over. */
  readonly defaults?: FakeTimersConfig | undefined
}

/**
 * The names `createTimerMembers` defines. Jest's `jest` object has the ones below `getRealSystemTime`
 * that are not Vitest-only; Vitest's `vi` has them all but `now`.
 * @public
 */
export type TimerMemberName =
  | 'useFakeTimers'
  | 'useRealTimers'
  | 'runAllTimers'
  | 'runAllTimersAsync'
  | 'runOnlyPendingTimers'
  | 'runOnlyPendingTimersAsync'
  | 'advanceTimersByTime'
  | 'advanceTimersByTimeAsync'
  | 'advanceTimersToNextTimer'
  | 'advanceTimersToNextTimerAsync'
  | 'advanceTimersToNextFrame'
  | 'runAllTicks'
  | 'clearAllTimers'
  | 'getTimerCount'
  | 'setSystemTime'
  | 'getRealSystemTime'
  | 'setTimerTickMode'
  | 'now'
  | 'isFakeTimers'
  | 'getMockedSystemTime'
