// The one thenable check: a describe body, a test's return value and a deadline's call all ask it.

/** Whether a value is a thenable (a promise or anything else with a `then` method). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
