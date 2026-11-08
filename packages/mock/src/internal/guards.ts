// Type guards the mock functions, spies and the module registry share.

/** An object or a function (anything a property can be read from, except `null`). */
export function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Whether `value` has a callable `then`. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isObjectLike(value) && typeof (value as Partial<PromiseLike<unknown>>).then === 'function'
}
