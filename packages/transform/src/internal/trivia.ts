// What the edits of the hoister and of the module-runner transform look through to find the next
// token: whitespace and comments, as the language reads them.

/**
 * What a line can start with and still continue the line before it, with no `;` between: a token
 * that cannot start a statement after a complete one without one.
 * @internal
 */
export const CONTINUES_LINE: ReadonlySet<string> = new Set(['[', '(', '`', '+', '-', '/', '<'])

const NON_ASCII_SPACE = /\s/

/**
 * The offset of the next character at or after `from` that is not whitespace or inside a comment
 * (`code.length` when there is none). Whitespace is what `\s` matches, so NBSP, U+FEFF and the line
 * and paragraph separators count; a `//` comment ends at `\n`, `\r`, U+2028 or U+2029; a `/*`
 * comment that never closes runs to the end.
 * @internal
 */
export function skipTrivia(code: string, from: number): number {
  let at = from
  while (at < code.length) {
    const char = code.charCodeAt(at)
    if (char === 32 || (char >= 9 && char <= 13)) {
      at++
    } else if (char === 47) {
      const next = code.charCodeAt(at + 1)
      if (next === 47) {
        at += 2
        while (at < code.length && !isLineBreak(code.charCodeAt(at))) at++
      } else if (next === 42) {
        const close = code.indexOf('*/', at + 2)
        if (close === -1) return code.length
        at = close + 2
      } else {
        return at
      }
    } else if (char > 127 && NON_ASCII_SPACE.test(code.charAt(at))) {
      at++
    } else {
      return at
    }
  }
  return at
}

function isLineBreak(char: number): boolean {
  return char === 10 || char === 13 || char === 0x2028 || char === 0x2029
}
