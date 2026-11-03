// A counting semaphore for `maxConcurrency` (Track 5 decision on concurrency groups and
// `concurrency.limitHooks`).

/** Runs at most `max` calls at once; the rest wait in order. */
export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>
  /** Calls running now. */
  readonly active: number
}

/** A limiter allowing `max` calls at once (`Infinity` or less than 1: no limit). */
export function createLimiter(max: number): Limiter {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : Number.POSITIVE_INFINITY
  const waiting: Array<() => void> = []
  let active = 0
  return {
    get active(): number {
      return active
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      // A released slot passes straight to the next waiter, so no new caller can take it first.
      if (active >= limit) await new Promise<void>((resume) => waiting.push(resume))
      else active++
      try {
        return await fn()
      } finally {
        const next = waiting.shift()
        if (next === undefined) active--
        else next()
      }
    },
  }
}

/** A limiter that never waits. */
export const unlimited: Limiter = {
  active: 0,
  run<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  },
}
