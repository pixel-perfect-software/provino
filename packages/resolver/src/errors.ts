/**
 * Error codes `@provino/resolver` throws.
 * @public
 */
export type ResolverErrorCode = 'RESOLVER_OPTION_UNSUPPORTED'

/**
 * A resolver error with a stable code.
 * @public
 */
export class ResolverError extends Error {
  readonly code: ResolverErrorCode

  constructor(code: ResolverErrorCode, message: string) {
    super(message)
    this.name = 'ResolverError'
    this.code = code
  }
}
