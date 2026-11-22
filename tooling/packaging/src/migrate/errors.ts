// Errors of the node:test codemod. Each carries a stable code (MIGRATE_*), so a test asserts on the
// code and not on the message.

/** The codes `MigrateError` carries. */
export type MigrateErrorCode =
  | 'MIGRATE_PARSE'
  | 'MIGRATE_UNSUPPORTED'
  | 'MIGRATE_USAGE'
  | 'MIGRATE_BASELINE'
  | 'MIGRATE_NO_BASELINE'
  | 'MIGRATE_RUN'
  | 'MIGRATE_MISMATCH'

/**
 * A migration step that cannot go on.
 * @internal
 */
export class MigrateError extends Error {
  readonly code: MigrateErrorCode

  constructor(code: MigrateErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MigrateError'
    this.code = code
  }
}
