/**
 * The `timers` slice, read by `@provino/timers` (Track 4).
 * @public
 */
export interface TimersPolicy {
  /**
   * What `useFakeTimers()` fakes when the call names nothing. Also Track 4's
   * `excludeFromDefaultToFake` (`[]` / `['nextTick', 'queueMicrotask']`).
   * Jest: `all`. Vitest: `all-but-microtasks`. unverified: track-01 L202, track-04 L348
   */
  readonly toFakeDefault: 'all' | 'all-but-microtasks'
  /** `runAllTimers` loop limit. Jest: 100000. Vitest: 10000. unverified: track-01 L203, track-04 L349 */
  readonly loopLimit: number
  /** Whether `Temporal` is faked. Jest: via sinon 15.4. Vitest: `true`. unverified: track-01 L204 */
  readonly fakeTemporal: boolean
  /** Whether legacy fake timers exist. Jest: `true`. Vitest: `false`. unverified: track-01 L205 */
  readonly legacyAvailable: boolean
  /** Whether fake timers are on for every test by default. Jest: `false`. Vitest: `false`. unverified: track-01 L206 */
  readonly enableGlobally: boolean
  /**
   * Which option names `useFakeTimers` takes: `do-not-fake` (`doNotFake`, `advanceTimers`,
   * `timerLimit`) or `to-fake` (`toFake`, `toNotFake`, `shouldAdvanceTime`). Track 4 names the values
   * `'jest' | 'vitest'`; renamed so neutral code never compares a runner name.
   * Jest: `do-not-fake`. Vitest: `to-fake`. unverified: track-04 L350
   */
  readonly optionNames: 'do-not-fake' | 'to-fake'
  /** Calling a timer API while timers are real. Values: Track 4 gives the union only; B14 records them. unverified: track-04 L351 */
  readonly notFaked: 'warn' | 'throw'
  /** `setSystemTime` while timers are real. Values: B14 records them. unverified: track-04 L352 */
  readonly setSystemTimeWithoutFakes: 'warn-noop' | 'fake-date-only'
  /** Whether `advanceTimersToNextTimer(steps)` honours `steps`. Jest: `true`. Vitest: `false`. unverified: track-04 L353 */
  readonly advanceToNextTimerHonorsSteps: boolean
  /** What the timer facade methods return. Values: B14 records them. unverified: track-04 L354 */
  readonly facadeReturns: 'void' | 'facade'
}
