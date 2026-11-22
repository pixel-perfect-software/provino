/**
 * The codes of `ProvinoApiError`: a module-mock call given a specifier that isn't a string
 * (`API_MOCK_SPECIFIER`), or a factory that isn't a function (`API_MOCK_FACTORY`).
 * @public
 */
export type ProvinoApiErrorCode = 'API_MOCK_SPECIFIER' | 'API_MOCK_FACTORY'

/**
 * A misuse of the native API, thrown where the call is made. A `TypeError`: each is a wrong
 * argument.
 * @public
 */
export class ProvinoApiError extends TypeError {
  readonly code: ProvinoApiErrorCode

  constructor(code: ProvinoApiErrorCode, message: string) {
    super(message)
    this.name = 'ProvinoApiError'
    this.code = code
  }
}
