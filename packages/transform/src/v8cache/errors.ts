/**
 * Error codes `@provino/transform/v8cache` throws. A cache that can't be read or written is never
 * an error (it misses); only a caller's mistake is.
 * @public
 */
export type V8CacheErrorCode = 'V8_CACHE_KEY_INVALID'

/**
 * A V8 code cache error with a stable code.
 * @public
 */
export class V8CacheError extends Error {
  readonly code: V8CacheErrorCode

  constructor(code: V8CacheErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'V8CacheError'
    this.code = code
  }
}
