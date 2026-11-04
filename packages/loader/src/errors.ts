/**
 * Error codes `@provino/loader` throws. `ERR_REQUIRE_ASYNC_MODULE` and `ERR_MODULE_NOT_FOUND`
 * keep Node's codes, since tests match on them.
 * @public
 */
export type LoaderErrorCode =
  | 'LOADER_NOT_IMPLEMENTED'
  | 'LOADER_TRANSFORM_FAILED'
  | 'LOADER_UNSUPPORTED_MODULE'
  | 'LOADER_TSCONFIG_NOT_FOUND'
  | 'LOADER_INVALID_MAPPER'
  | 'ERR_MODULE_NOT_FOUND'
  | 'ERR_REQUIRE_ASYNC_MODULE'

/**
 * A loader error with a stable code.
 * @public
 */
export class LoaderError extends Error {
  readonly code: LoaderErrorCode

  constructor(code: LoaderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LoaderError'
    this.code = code
  }
}
