/**
 * The `timers` slice, read by `@provino/timers` (Track 4).
 * @public
 */
export interface TimersPolicy {
  /**
   * What `useFakeTimers()` fakes when the call names nothing. Also Track 4's
   * `excludeFromDefaultToFake` (`[]` / `['nextTick', 'queueMicrotask']`).
   * Jest: `all`. Vitest: `all-but-microtasks`. research: track-01 L202, track-04 L348
   */
  readonly toFakeDefault: 'all' | 'all-but-microtasks'
  /** `runAllTimers` loop limit. Jest: 100000. Vitest: 10000. research: track-01 L203, track-04 L349 */
  readonly loopLimit: number
  /**
   * Whether `Temporal` is faked: in the default set, and with `setSystemTime` while timers are real.
   * Jest: `true` (its @sinonjs/fake-timers 15.4 fakes it). Vitest: `true`. Recorded:
   * `mocking/timers-temporal` (B17a), on a Node run with `--harmony-temporal`. research: track-01 L204
   */
  readonly fakeTemporal: boolean
  /** Whether legacy fake timers exist. Jest: `true`. Vitest: `false`. research: track-01 L205 */
  readonly legacyAvailable: boolean
  /** Whether fake timers are on for every test by default. Jest: `false`. Vitest: `false`. research: track-01 L206 */
  readonly enableGlobally: boolean
  /**
   * Which option names `useFakeTimers` takes: `do-not-fake` (`doNotFake`, `advanceTimers`,
   * `timerLimit`) or `to-fake` (`toFake`, `toNotFake`, `shouldAdvanceTime`). Track 4 names the values
   * `'jest' | 'vitest'`; renamed so neutral code never compares a runner name.
   * Jest: `do-not-fake`. Vitest: `to-fake`. research: track-04 L350
   */
  readonly optionNames: 'do-not-fake' | 'to-fake'
  /** Calling a timer API while timers are real. Values: Track 4 gives the union only; B14 records them. research: track-04 L351 */
  readonly notFaked: 'warn' | 'throw'
  /** `setSystemTime` while timers are real. Values: B14 records them. research: track-04 L352 */
  readonly setSystemTimeWithoutFakes: 'warn-noop' | 'fake-date-only'
  /** Whether `advanceTimersToNextTimer(steps)` honours `steps`. Jest: `true`. Vitest: `false`. research: track-04 L353 */
  readonly advanceToNextTimerHonorsSteps: boolean
  /**
   * What the timer members of the `jest`/`vi` object return: only the ones that switch timers on or
   * off (`useFakeTimers`, `useRealTimers`, `setTimerTickMode`) hand back the object (`lifecycle`),
   * or every member does, an async one resolving to it (`all`). Track 4 gave `'void' | 'facade'`;
   * B17a recorded that Jest chains three members and Vitest all of them (`mocking/timers-facade`).
   * Jest: `lifecycle`. Vitest: `all`. research: track-04 L354
   */
  readonly facadeReturns: 'lifecycle' | 'all'
  /**
   * The dialect's words. `notFaked` is the text of the warning (`notFaked: 'warn'`) or the error
   * (`'throw'`) for an advance call made while timers are real. A `{stack}` in it is replaced with
   * the caller's stack frames (Jest's warning ends with `Stack Trace:` and the formatted stack).
   * Jest: its warning. Vitest: its error. Recorded: `mocking/timers-not-faked` (B17a).
   */
  readonly messages: {
    readonly notFaked: string
  }
}
