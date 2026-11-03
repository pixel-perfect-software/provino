/**
 * The text of a caught value: an `Error`'s message, else the value as a string.
 * @internal
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a caught value is an `Error` with this `code`: a system error (`ENOENT`, `ESRCH`) or one
 * of ours.
 * @internal
 */
export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
