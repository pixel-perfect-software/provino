// What a test's identity prints as. The test key and the duplicate count must use the same text,
// or two different tests can share one key.

/** Joins the titles of a test's path. */
export const TITLE_SEPARATOR = ' › '

/** The path of a test as it appears in a key: `describe › nested › title`. */
export function pathText(path: readonly string[]): string {
  return path.join(TITLE_SEPARATOR)
}
