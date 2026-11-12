/**
 * Error codes `@provino/resolver` throws.
 * @public
 */
export type ResolverErrorCode =
  | 'RESOLVER_OPTION_UNSUPPORTED'
  | 'RESOLVER_BAD_MAPPER'
  | 'RESOLVER_CUSTOM_FAILED'

/**
 * A resolver error with a stable code.
 * @public
 */
export class ResolverError extends Error {
  readonly code: ResolverErrorCode

  constructor(code: ResolverErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResolverError'
    this.code = code
  }
}
