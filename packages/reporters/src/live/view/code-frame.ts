// The lines of source around a failure: two above, the line, two below, with a gutter, a marker on
// the failing line and a caret under the column. Pure: the text is cut by `sliceLines`, which scans
// only as far as it needs.

import type { Style } from '../../style.ts'

/** Lines of source: `lines[0]` is line number `first` (1-based). */
export interface Snippet {
  readonly first: number
  readonly lines: readonly string[]
}

/** How many lines show above and below the failing one. */
export const CONTEXT_LINES = 2

/**
 * The lines `from` to `to` (1-based, inclusive) of `text`, scanning no further than `to`. Fewer
 * come back when the text ends first; none when `from` is past the end.
 */
export function sliceLines(text: string, from: number, to: number): string[] {
  const out: string[] = []
  let start = 0
  for (let number = 1; number <= to; number++) {
    if (start > text.length) break
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    if (number >= from) {
      const line = text.slice(start, end)
      out.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
    start = end + 1
  }
  return out
}

/** The snippet around `line` of `text`, or `undefined` when the line isn't there. */
export function snippetAround(text: string, line: number): Snippet | undefined {
  const first = Math.max(1, line - CONTEXT_LINES)
  const lines = sliceLines(text, first, line + CONTEXT_LINES)
  if (lines.length < line - first + 1) return undefined
  return { first, lines }
}

const TAB = '  '

/**
 * The code frame's lines, none wider than `room` columns (the caller indents them).
 * @beta
 */
export function codeFrameLines(
  snippet: Snippet,
  line: number,
  column: number,
  room: number,
  style: Style,
): string[] {
  const last = snippet.first + snippet.lines.length - 1
  const gutter = String(last).length
  const out: string[] = []
  const cut = (text: string): string =>
    text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text
  snippet.lines.forEach((raw, index) => {
    const number = snippet.first + index
    const text = raw.replaceAll('\t', TAB)
    const marker = number === line ? '>' : ' '
    const numberText = String(number).padStart(gutter)
    const row = cut(`${marker} ${numberText} │ ${text}`)
    out.push(number === line ? row : style.dim(row))
    if (number === line && column >= 1) {
      const lead = raw.slice(0, column - 1).replaceAll('\t', TAB).length
      out.push(style.red(cut(`  ${' '.repeat(gutter)} │ ${' '.repeat(lead)}^`)))
    }
  })
  return out
}
