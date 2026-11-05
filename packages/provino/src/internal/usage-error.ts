/**
 * Codes for `UsageError`.
 *
 * - `PROVINO_USAGE`: an option or argument is missing, unknown or has the wrong value.
 * @internal
 */
export type UsageErrorCode = 'PROVINO_USAGE'

/**
 * Bad input to `run()` or the `provino` command. `run()` turns it into the exit code 2 and the
 * message on stderr; it never reaches a caller.
 * @internal
 */
export class UsageError extends Error {
  override readonly name = 'UsageError'
  readonly code: UsageErrorCode = 'PROVINO_USAGE'
}
