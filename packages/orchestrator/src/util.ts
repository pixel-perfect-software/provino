// Small helpers the coordinator's modules share. Not exported from the package.

/** `-1`, `0` or `1` by UTF-16 code unit order, which is the same on every machine (`localeCompare` is not). */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The message of a thrown value: an `Error`'s own, else the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
