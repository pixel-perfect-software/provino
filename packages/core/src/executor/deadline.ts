// Real-timer deadlines (Track 5 decision 9). Timeouts use timers captured before user code runs
// (the caller passes the loader's capture; the default is what was global when core loaded), so
// fake timers can't freeze them. An elapsed-time check on settle catches synchronous overruns
// when the policy asks (`timeouts.catchSyncOverrun`). `createDeadlines` owns every user call's
// deadline: its bound, its `CORE_TIMEOUT` message and the test signal it aborts.
import type { CorePolicy } from '@provino/types'
import { CoreError } from '../errors.ts'
import { isThenable } from '../internal/thenable.ts'

/**
 * The timer functions deadlines use.
 * @public
 */
export interface RealTimers {
  readonly setTimeout: typeof globalThis.setTimeout
  readonly clearTimeout: typeof globalThis.clearTimeout
}

/** The timers that were global when core loaded. */
export const capturedTimers: RealTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
}

/** The longest delay a timer holds: Node fires a longer one after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** Whether a timeout sets a deadline: 0, `Infinity`, `NaN` and delays no timer can hold don't. */
export function isBounded(timeoutMs: number): boolean {
  return timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS
}

/** Keeps a pending deadline from holding the process open, where the timer supports it. */
function unref(timer: unknown): void {
  if (typeof timer !== 'object' || timer === null || !('unref' in timer)) return
  if (typeof timer.unref === 'function') timer.unref()
}

const disarmed = (): void => {}

/**
 * Calls `onExpire` once `timeoutMs` has passed, unless the function it returns is called first.
 * An unbounded timeout sets no timer. The timer never holds the process open.
 */
export function armDeadline(
  timeoutMs: number,
  timers: RealTimers,
  onExpire: () => void,
): () => void {
  if (!isBounded(timeoutMs)) return disarmed
  const timer = timers.setTimeout(onExpire, timeoutMs)
  unref(timer)
  return () => timers.clearTimeout(timer)
}

/**
 * Resolves once `ms` has passed on `timers`. A wait no timer can hold (`isBounded`: 0 or less,
 * `NaN`, or more than 2^31-1 ms, which Node would fire after 1 ms) resolves at once, as
 * `armDeadline` sets no timer for it. Unlike a deadline, the timer holds the process open: the
 * caller is waiting on it.
 */
export function sleep(timers: RealTimers, ms: number): Promise<void> {
  if (!isBounded(ms)) return Promise.resolve()
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms)
  })
}

/** How one call is bounded. */
export interface DeadlineOptions {
  /** 0, `Infinity` or more than a timer holds: no deadline. */
  readonly timeoutMs: number
  readonly catchSyncOverrun: boolean
  readonly timers: RealTimers
  readonly now: () => number
  /** The error the call fails with when it runs out of time. */
  readonly timeoutError: () => Error
  /** Called once when the deadline passes (to abort the test's signal). */
  readonly onTimeout?: ((error: Error) => void) | undefined
  /**
   * When the call started, if the caller read the clock for it just before (the `hook-start`
   * event's time): saves reading it again. Default: `now()` as the call starts.
   */
  readonly start?: number | undefined
}

/**
 * Runs `invoke` and settles with its result, its error, or the timeout error, whichever comes
 * first. A synchronous throw becomes a rejection. A call that returns no thenable settles without
 * a timer; for a thenable the timer is armed for what is left of `timeoutMs`, so the deadline is
 * still `timeoutMs` after the call started.
 */
export function withDeadline(invoke: () => unknown, options: DeadlineOptions): Promise<unknown> {
  const { timeoutMs, now } = options
  const bounded = isBounded(timeoutMs)
  const start = bounded ? (options.start ?? now()) : 0
  const overran = (): boolean => bounded && options.catchSyncOverrun && now() - start > timeoutMs
  let result: unknown
  try {
    result = invoke()
  } catch (error) {
    return Promise.reject(overran() ? timedOut(options) : error)
  }
  if (!isThenable(result)) {
    return overran() ? Promise.reject(timedOut(options)) : Promise.resolve(result)
  }
  const pending = result
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = (): void => {
      if (settled) return
      settled = true
      reject(timedOut(options))
    }
    // At least 1 ms (a spent deadline still waits for the call's own settling first), and whole
    // milliseconds, so timers with the same timeout share Node's timer list.
    const disarm = bounded
      ? armDeadline(Math.max(1, Math.ceil(timeoutMs - (now() - start))), options.timers, timeout)
      : disarmed
    const finish = (settle: () => void): void => {
      disarm()
      if (settled) return
      if (overran()) {
        timeout()
        return
      }
      settled = true
      settle()
    }
    try {
      pending.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      )
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

/** The timeout error, after `onTimeout` has seen it. */
function timedOut(options: DeadlineOptions): Error {
  const error = options.timeoutError()
  options.onTimeout?.(error)
  return error
}

/** What timed out, for a `CORE_TIMEOUT` error's message: a hook also stands for a hook-like callback. */
export type TimeoutSubject = 'test' | 'hook' | 'teardown' | 'listener'

const TIMEOUT_MESSAGES: Readonly<Record<TimeoutSubject, (ms: number) => string>> = {
  test: (ms) => `Test timed out in ${ms}ms.`,
  hook: (ms) => `Hook timed out in ${ms}ms.`,
  teardown: (ms) => `Teardown timed out in ${ms}ms.`,
  listener: (ms) => `An onCollected listener timed out after ${ms}ms.`,
}

/** A test attempt, whose signal a timeout aborts. */
interface Abortable {
  readonly controller: AbortController
}

/** How one user call is bounded. */
export interface DeadlineCall {
  readonly what: TimeoutSubject
  /** The bound: 0, `Infinity` or more than a timer holds sets none. */
  readonly timeoutMs: number
  /** The timeout the message names, when `timeoutMs` is what an attempt deadline left of it. */
  readonly namedMs?: number
  /** The attempt the call belongs to: a timeout aborts its signal. */
  readonly attempt?: Abortable | undefined
  /** Default: `timeouts.catchSyncOverrun`. */
  readonly catchSyncOverrun?: boolean
  /** When the call started, if the caller has just read the clock (`DeadlineOptions.start`). */
  readonly start?: number | undefined
}

/** Where a teardown stack stops, and whose signal a timeout aborts. */
export interface DrainOptions {
  /** Entries below this index are left for a later drain. Default 0. */
  readonly keep?: number
  readonly attempt?: Abortable | undefined
}

/** Every deadline a runtime sets. */
export interface Deadlines {
  /** Runs `fn` under the call's bound; a timeout fails it with `CORE_TIMEOUT`. */
  call(fn: () => unknown, spec: DeadlineCall): Promise<unknown>
  /**
   * Runs a teardown stack last added first, each under `timeouts.teardown`, until `keep` entries
   * are left; one added meanwhile runs too. Returns what they threw, in the order they ran.
   */
  drain(stack: Array<() => unknown>, options?: DrainOptions): Promise<unknown[]>
}

/** A runtime's deadlines, on the timers and clock it was given. */
export function createDeadlines(
  timeouts: CorePolicy['timeouts'],
  timers: RealTimers,
  now: () => number,
): Deadlines {
  const optionsFor = (spec: DeadlineCall): DeadlineOptions => {
    const { attempt } = spec
    const named = spec.namedMs ?? spec.timeoutMs
    return {
      timeoutMs: spec.timeoutMs,
      catchSyncOverrun: spec.catchSyncOverrun ?? timeouts.catchSyncOverrun,
      timers,
      now,
      timeoutError: () => new CoreError('CORE_TIMEOUT', TIMEOUT_MESSAGES[spec.what](named)),
      onTimeout: attempt === undefined ? undefined : (error) => attempt.controller.abort(error),
      start: spec.start,
    }
  }
  return {
    call: (fn, spec) => withDeadline(fn, optionsFor(spec)),
    async drain(stack, { keep = 0, attempt } = {}) {
      const options = optionsFor({ what: 'teardown', timeoutMs: timeouts.teardown, attempt })
      const errors: unknown[] = []
      while (stack.length > keep) {
        const teardown = stack.pop()
        if (teardown === undefined) continue
        try {
          await withDeadline(teardown, options)
        } catch (error) {
          errors.push(error)
        }
      }
      return errors
    },
  }
}

/** A user's timeout with `timeouts.zero` applied: under `'default'`, `0` is no timeout given. */
export function resolveTimeout(
  timeouts: CorePolicy['timeouts'],
  timeoutMs: number | undefined,
): number | undefined {
  return timeoutMs === 0 && timeouts.zero === 'default' ? undefined : timeoutMs
}
