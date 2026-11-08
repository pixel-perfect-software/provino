/**
 * Error codes `@provino/loader` throws. `ERR_REQUIRE_ASYNC_MODULE` keeps Node's code, since tests
 * match on it; a module that isn't found is a `ModuleNotFoundError`, with Node's codes.
 * @public
 */
export type LoaderErrorCode =
  | 'LOADER_NOT_IMPLEMENTED'
  | 'LOADER_TRANSFORM_FAILED'
  | 'LOADER_UNSUPPORTED_MODULE'
  | 'LOADER_TSCONFIG_NOT_FOUND'
  | 'LOADER_INVALID_MAPPER'
  | 'LOADER_NO_MODULE_MOCKS'
  | 'LOADER_NO_REAL_MODULE'
  | 'LOADER_UNRESOLVED_MOCK'
  | 'ERR_REQUIRE_ASYNC_MODULE'

/**
 * A specifier that doesn't resolve, thrown when its import or `require` runs. Its `name` stays
 * `Error`, as Node's own not-found errors and jest-resolve's `ModuleNotFoundError` have it, since
 * tests print and compare it; the text is the dialect's (`module-not-found`).
 * @public
 */
export class ModuleNotFoundError extends Error {
  readonly code: 'ERR_MODULE_NOT_FOUND' | 'MODULE_NOT_FOUND'

  constructor(code: 'ERR_MODULE_NOT_FOUND' | 'MODULE_NOT_FOUND', message: string) {
    super(message)
    this.code = code
  }
}

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
