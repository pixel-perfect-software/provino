// @provino/timers: the fake clock over @sinonjs/fake-timers, and the timer members of `jest` and `vi`.
// Neutral: every Jest/Vitest difference is a `TimersPolicy` value the dialect supplies.
export { createFakeClock } from './clock.ts'
export { TimersError, type TimersErrorCode } from './errors.ts'
export { createTimerMembers, type TimerMembers } from './members.ts'
export type {
  AdvanceBy,
  FakeClock,
  FakeClockOptions,
  FakeMethod,
  FakeTimersConfig,
  SystemTime,
  TemporalDurationLike,
  TemporalTimelike,
  TimerMemberName,
  TimerTickMode,
} from './types.ts'
