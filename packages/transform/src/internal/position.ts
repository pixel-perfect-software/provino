// Offsets to the positions a diagnostic reports.

export interface Position {
  readonly line: number
  readonly column: number
}

/**
 * A reader of 1-based line and column for UTF-16 offsets in ascending order. It never rescans, so
 * many positions in one file cost one pass over it.
 */
export function positionCursor(code: string): (offset: number) => Position {
  let line = 1
  let lineStart = 0
  let next = code.indexOf('\n')
  return (offset) => {
    while (next !== -1 && next < offset) {
      line++
      lineStart = next + 1
      next = code.indexOf('\n', next + 1)
    }
    return { line, column: offset - lineStart + 1 }
  }
}

/** 1-based line and column of one UTF-16 offset. */
export function positionOf(code: string, offset: number): Position {
  return positionCursor(code)(offset)
}
