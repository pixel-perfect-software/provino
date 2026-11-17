// One running file's line in the footer: a spinner frame, the worker's number, the path (cut from
// the left, so the file name stays), and how long the file has run, right-aligned in a column of
// its own from the file's first frame, with a mark once it is slow (its slot kept when it is not,
// so the column never moves).
// Pure: the reporter rebuilds a line only when the spinner frame or the tenth of a second changes.

import type { Glyphs } from '../terminal/glyphs.ts'
import { displayWidth, fitWidthLeft } from '../terminal/width.ts'
import { clock } from './format.ts'

/** A file with no expected time that has run this long is marked slow. */
export const SLOW_FILE_MS = 2000
/** A file with an expected time is marked slow once it passes it, but never under this long. */
export const EXPECTED_FLOOR_MS = 500
/** The width of the time column: `0.0s` to `59.9s`, `1m 05s`, `1h 02m`. */
export const TIME_COLUMN = 6

/**
 * One worker line, `columns - 1` columns wide at most.
 * @beta
 */
export function workerLine(
  workerNumber: number,
  path: string,
  elapsedMs: number,
  spinnerPhase: number,
  columns: number,
  glyphs: Glyphs,
  expectedMs?: number,
): string {
  const spinner = glyphs.spinner[spinnerPhase % glyphs.spinner.length] as string
  const prefix = ` ${spinner} ${workerNumber}  `
  const slow =
    expectedMs === undefined
      ? elapsedMs >= SLOW_FILE_MS
      : elapsedMs > Math.max(expectedMs, EXPECTED_FLOOR_MS)
  const mark = ` ${glyphs.slow}`
  const time = clock(elapsedMs).padStart(TIME_COLUMN)
  const tail = slow ? `${time}${mark}` : time
  const room = Math.max(1, columns - 1)
  // The mark's slot is kept whether or not it is drawn, so the time stays in one column.
  const pathRoom = room - displayWidth(prefix) - displayWidth(time) - displayWidth(mark) - 1
  if (pathRoom < 4) return `${prefix}${tail}`
  const shown = fitWidthLeft(path, pathRoom)
  return `${prefix}${shown}${' '.repeat(pathRoom - displayWidth(shown) + 1)}${tail}`
}

/** The line that says how many busy workers the footer has no room for. */
export function moreWorkersLine(count: number): string {
  return ` + ${count} more worker${count === 1 ? '' : 's'}`
}
