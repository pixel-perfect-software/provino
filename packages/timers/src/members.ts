// The timer members of the `jest` and `vi` objects, over one clock. A dialect's facade copies the
// names it has (Jest: no `isFakeTimers` or `getMockedSystemTime`; Vitest: no `now`), so a name the
// runner lacks never appears on its object. What each member returns is `TimersPolicy.facadeReturns`.
import type { TimersPolicy } from '@provino/types'
import { TimersError } from './errors.ts'
import type {
  FakeClock,
  FakeTimersConfig,
  SystemTime,
  TimerMemberName,
  TimerTickMode,
} from './types.ts'

type Member = (...args: never[]) => unknown

/**
 * The members, each loosely typed: the object that carries them is the dialect's, and its types are
 * the dialect's own.
 * @public
 */
export type TimerMembers = Readonly<Record<TimerMemberName, Member>>

/** Members that switch timers on or off, which `lifecycle` returns the facade from. */
const LIFECYCLE: ReadonlySet<TimerMemberName> = new Set([
  'useFakeTimers',
  'useRealTimers',
  'setTimerTickMode',
])

/** Members that answer a question: they return their answer under every `facadeReturns`. */
const ANSWERS: ReadonlySet<TimerMemberName> = new Set([
  'getTimerCount',
  'getRealSystemTime',
  'getMockedSystemTime',
  'isFakeTimers',
  'now',
])

/** Vitest's `setTimerTickMode(mode, interval)` strings, and the sinon names Jest passes. */
function tickMode(mode: unknown, interval: number | undefined): TimerTickMode {
  if (typeof mode === 'object' && mode !== null) return mode as TimerTickMode
  if (mode === 'manual') return { mode: 'manual' }
  if (mode === 'nextTimerAsync') return { mode: 'nextAsync' }
  if (mode === 'interval') return { mode: 'interval', delta: interval }
  throw new TimersError('TIMERS_INVALID_TICK_MODE', `Invalid tick mode: ${String(mode)}`)
}

/**
 * Builds the timer members. `clock` returns the clock of the file running now (read when a member
 * is called, because each file has its own); `facade` returns the object that carries the members
 * (read when a member returns, so it may be built after this call).
 * @public
 */
export function createTimerMembers(
  clock: () => FakeClock,
  policy: TimersPolicy,
  facade: () => unknown,
): TimerMembers {
  const chain = (name: TimerMemberName): boolean =>
    !ANSWERS.has(name) && (policy.facadeReturns === 'all' || LIFECYCLE.has(name))
  const syncMember =
    <A extends unknown[]>(name: TimerMemberName, run: (...args: A) => void) =>
    (...args: A): unknown => {
      run(...args)
      return chain(name) ? facade() : undefined
    }
  const asyncMember =
    <A extends unknown[]>(name: TimerMemberName, run: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<unknown> => {
      await run(...args)
      return chain(name) ? facade() : undefined
    }
  return {
    useFakeTimers: syncMember('useFakeTimers', (config?: FakeTimersConfig) =>
      clock().install(config),
    ),
    useRealTimers: syncMember('useRealTimers', () => clock().uninstall()),
    runAllTimers: syncMember('runAllTimers', () => clock().runAll()),
    runAllTimersAsync: asyncMember('runAllTimersAsync', () => clock().runAllAsync()),
    runOnlyPendingTimers: syncMember('runOnlyPendingTimers', () => clock().runPending()),
    runOnlyPendingTimersAsync: asyncMember('runOnlyPendingTimersAsync', () =>
      clock().runPendingAsync(),
    ),
    advanceTimersByTime: syncMember('advanceTimersByTime', (ms: number) => clock().advanceBy(ms)),
    advanceTimersByTimeAsync: asyncMember('advanceTimersByTimeAsync', (ms: number) =>
      clock().advanceByAsync(ms),
    ),
    advanceTimersToNextTimer: syncMember('advanceTimersToNextTimer', (steps?: number) =>
      clock().next(steps),
    ),
    advanceTimersToNextTimerAsync: asyncMember('advanceTimersToNextTimerAsync', (steps?: number) =>
      clock().nextAsync(steps),
    ),
    advanceTimersToNextFrame: syncMember('advanceTimersToNextFrame', () => clock().nextFrame()),
    runAllTicks: syncMember('runAllTicks', () => clock().runMicrotasks()),
    clearAllTimers: syncMember('clearAllTimers', () => clock().clearAll()),
    getTimerCount: (): number => clock().count(),
    setSystemTime: syncMember('setSystemTime', (time?: SystemTime | string) =>
      clock().setSystemTime(typeof time === 'string' ? new Date(time) : time),
    ),
    getRealSystemTime: (): number => clock().getRealSystemTime(),
    setTimerTickMode: syncMember('setTimerTickMode', (mode: unknown, interval?: number) =>
      clock().setTickMode(tickMode(mode, interval)),
    ),
    now: (): number => clock().now(),
    isFakeTimers: (): boolean => clock().isInstalled(),
    getMockedSystemTime: (): Date | null => clock().mockedSystemTime(),
  }
}
