// Real-timer deadlines (Track 5 decision 9). Timeouts use timers captured before user code runs
// (the caller passes the loader's capture; the default is what was global when core loaded), so
// fake timers can't freeze them. An elapsed-time check on settle catches synchronous overruns
// when the policy asks (`timeouts.catchSyncOverrun`).

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

/** How one call is bounded. */
export interface DeadlineOptions {
  /** 0 or `Infinity`: no deadline. */
  readonly timeoutMs: number
  readonly catchSyncOverrun: boolean
  readonly timers: RealTimers
  readonly now: () => number
  /** The error the call fails with when it runs out of time. */
  readonly timeoutError: () => Error
  /** Called once when the deadline passes (to abort the test's signal). */
  readonly onTimeout?: (error: Error) => void
}

/**
 * Runs `invoke` and settles with its result, its error, or the timeout error, whichever comes
 * first. A synchronous throw becomes a rejection.
 */
export function withDeadline(invoke: () => unknown, options: DeadlineOptions): Promise<unknown> {
  const { timeoutMs, timers, now } = options
  const bounded = timeoutMs > 0 && Number.isFinite(timeoutMs)
  return new Promise((resolve, reject) => {
    let settled = false
    const start = now()
    const timeout = (): void => {
      if (settled) return
      settled = true
      const error = options.timeoutError()
      options.onTimeout?.(error)
      reject(error)
    }
    const timer = bounded ? timers.setTimeout(timeout, timeoutMs) : undefined
    const finish = (settle: () => void): void => {
      if (timer !== undefined) timers.clearTimeout(timer)
      if (settled) return
      if (bounded && options.catchSyncOverrun && now() - start > timeoutMs) {
        timeout()
        return
      }
      settled = true
      settle()
    }
    try {
      const result = invoke()
      if (isThenable(result)) {
        result.then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        )
      } else {
        finish(() => resolve(result))
      }
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
