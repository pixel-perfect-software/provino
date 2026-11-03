// What a test's identity prints as. `testKey` (normalize.ts) and the duplicate count
// (`identityAllocator` in convert.ts) both use `pathText`, so they cannot disagree about which tests
// are the same.

const TITLE_SEPARATOR = ' › '
const ESCAPE = '\\'

/** Escapes the two characters that carry meaning in a path: the escape and the separator's `›`. */
function escapeTitle(title: string): string {
  return title.replace(/[\\›]/g, (char) => `${ESCAPE}${char}`)
}

/**
 * The path of a test as it appears in a key: `describe › nested › title`. Each title has `\` and
 * `›` escaped, so the text parses back to one title list: two different (non-empty) title arrays
 * never print the same, and titles without those two characters print as they are.
 */
export function pathText(path: readonly string[]): string {
  return path.map(escapeTitle).join(TITLE_SEPARATOR)
}
