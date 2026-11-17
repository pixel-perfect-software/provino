// One running file's line in the footer: a spinner frame, the worker's number, the path (cut from
// the left, so the file name stays), and how long the file has run, with a mark once it is slow.
// Pure: the reporter rebuilds a line only when the spinner frame or the tenth of a second changes.

import type { Glyphs } from '../terminal/glyphs.ts'
import { displayWidth, fitWidthLeft } from '../terminal/width.ts'
import { clock } from './format.ts'

/** A file that has run this long is marked slow. */
export const SLOW_FILE_MS = 2000

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
): string {
  const spinner = glyphs.spinner[spinnerPhase % glyphs.spinner.length] as string
  const prefix = ` ${spinner} ${workerNumber}  `
  const time = clock(elapsedMs) + (elapsedMs >= SLOW_FILE_MS ? ` ${glyphs.slow}` : '')
  const room = Math.max(1, columns - 1)
  const pathRoom = room - displayWidth(prefix) - displayWidth(time) - 1
  if (pathRoom < 4) return `${prefix}${time}`
  const shown = fitWidthLeft(path, pathRoom)
  return `${prefix}${shown}${' '.repeat(pathRoom - displayWidth(shown) + 1)}${time}`
}

/** The line that says how many busy workers the footer has no room for. */
export function moreWorkersLine(count: number): string {
  return ` + ${count} more worker${count === 1 ? '' : 's'}`
}
