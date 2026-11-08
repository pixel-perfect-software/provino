/*
 * natural-compare 1.4.0 (https://github.com/litejs/natural-compare-lite)
 * @author  Lauri Rooden
 * @license MIT License
 *
 * The comparison both Jest and Vitest sort a `.snap` file's keys with, ported to TypeScript.
 */

// provino: `String.alphabet`, an optional global hook the original reads, is not supported: nothing
// sets it, and a hidden global would make the order of a file depend on the process.

/**
 * Orders strings so that numbers inside them compare as numbers: `numbers 2` before `numbers 10`.
 * @public
 */
export function naturalCompare(first: string, second: string): number {
  let index = 0
  let codeA = 0
  let codeB = 1
  let posA = 0
  let posB = 0

  function getCode(text: string, pos: number, numeric: boolean): number {
    if (numeric) {
      // A digit maps to 66 < code < 76 (below), and continues the number.
      const isDigit = (at: number): boolean => {
        const code = getCode(text, at, false)
        return code < 76 && code > 65
      }
      index = pos
      while (isDigit(index)) ++index
      return +text.slice(pos - 1, index)
    }
    const code = text.charCodeAt(pos) || 0
    if (code < 45 || code > 127) return code
    if (code < 46) return 65 // -
    if (code < 48) return code - 1
    if (code < 58) return code + 18 // 0-9
    if (code < 65) return code - 11
    if (code < 91) return code + 11 // A-Z
    if (code < 97) return code - 37
    if (code < 123) return code + 5 // a-z
    return code - 63
  }

  const a = `${first}`
  const b = `${second}`
  if (a !== b) {
    while (codeB) {
      codeA = getCode(a, posA++, false)
      codeB = getCode(b, posB++, false)

      if (codeA < 76 && codeB < 76 && codeA > 66 && codeB > 66) {
        codeA = getCode(a, posA, true)
        posA = index
        codeB = getCode(b, posB, true)
        posB = index
      }

      if (codeA !== codeB) return codeA < codeB ? -1 : 1
    }
  }
  return 0
}
