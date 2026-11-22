/**
 * The codes of `ProvinoApiError`: a module-mock call given a specifier that isn't a string
 * (`API_MOCK_SPECIFIER`) or a factory that isn't a function (`API_MOCK_FACTORY`); a factory that
 * read a binding before it was initialized (`API_MOCK_FACTORY_UNINITIALIZED`); a mock called from a
 * module isolation `none` shares between files (`API_MOCK_SHARED_MODULE`).
 * @public
 */
export type ProvinoApiErrorCode =
  | 'API_MOCK_SPECIFIER'
  | 'API_MOCK_FACTORY'
  | 'API_MOCK_FACTORY_UNINITIALIZED'
  | 'API_MOCK_SHARED_MODULE'

/**
 * A misuse of the native API, thrown where the call is made (a factory's, when it runs).
 * @public
 */
export class ProvinoApiError extends Error {
  readonly code: ProvinoApiErrorCode

  constructor(code: ProvinoApiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProvinoApiError'
    this.code = code
  }
}
