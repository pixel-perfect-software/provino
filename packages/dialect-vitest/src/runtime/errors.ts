// The Vitest dialect's runtime errors.

/**
 * The code a `VitestDialectError` carries.
 * @public
 */
export type VitestDialectErrorCode =
  | 'VITEST_DIALECT_NOT_BUILT'
  | 'VITEST_ENVIRONMENT_NOT_FOUND'
  | 'VITEST_ENVIRONMENT_NOT_INSTALLED'
  | 'VITEST_ENVIRONMENT_SETUP_VM'

/**
 * An error from the Vitest dialect.
 * @public
 */
export class VitestDialectError extends Error {
  override readonly name = 'VitestDialectError'
  readonly code: VitestDialectErrorCode

  constructor(code: VitestDialectErrorCode, message: string) {
    super(message)
    this.code = code
  }
}
