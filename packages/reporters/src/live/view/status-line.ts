// The footer's first line: the test counts, a progress bar, the files done and the time. It is a
// pure function of its inputs, so a frame rebuilds it only when they change. At a narrow width it
// drops the bar first, then the file count, then the time left.

import type { Style } from '../../style.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { displayWidth, fitWidth } from '../terminal/width.ts'
import { clock, groupDigits, roughDuration } from './format.ts'

/**
 * What the status line shows.
 * @beta
 */
export interface StatusInput {
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  readonly todo: number
  readonly filesDone: number
  readonly filesTotal: number
  readonly elapsedMs: number
  /** The expected time left, when the estimator can say. */
  readonly leftMs: number | undefined
}

/** The widest the bar gets, and the narrowest it is worth drawing. */
const BAR_MAX = 24
const BAR_MIN = 8

function counts(input: StatusInput, glyphs: Glyphs, style: Style): string {
  const parts = [style.green(`${glyphs.pass} ${groupDigits(input.passed)}`)]
  if (input.failed > 0) parts.push(style.red(`${glyphs.fail} ${groupDigits(input.failed)}`))
  if (input.skipped > 0) parts.push(style.yellow(`${glyphs.skipped} ${groupDigits(input.skipped)}`))
  if (input.todo > 0) parts.push(style.yellow(`${glyphs.todo} ${groupDigits(input.todo)}`))
  return parts.join('  ')
}

function bar(
  done: number,
  total: number,
  cells: number,
  glyphs: Glyphs,
  style: Style,
  red: boolean,
): string {
  const filled = total === 0 ? 0 : Math.min(cells, Math.floor((done / total) * cells))
  const full = glyphs.barFull.repeat(filled)
  return (
    (red ? style.red(full) : style.green(full)) + style.dim(glyphs.barEmpty.repeat(cells - filled))
  )
}

/**
 * The status line, at most `columns - 1` columns wide.
 * @beta
 */
export function statusLine(
  input: StatusInput,
  columns: number,
  glyphs: Glyphs,
  style: Style,
): string {
  const room = Math.max(1, columns - 1)
  const percent =
    input.filesTotal === 0 ? 0 : Math.floor((input.filesDone / input.filesTotal) * 100)
  const head = counts(input, glyphs, style)
  const percentText = `${percent}%`.padStart(4)
  const filesText = `${groupDigits(input.filesDone)} of ${groupDigits(input.filesTotal)} files`
  const timeText = clock(input.elapsedMs)
  const leftText = input.leftMs === undefined ? '' : ` · ~${roughDuration(input.leftMs)} left`

  const assemble = (cells: number, files: boolean, left: boolean): string => {
    let line = head
    if (cells > 0) {
      line += `   ${bar(input.filesDone, input.filesTotal, cells, glyphs, style, input.failed > 0)}`
    }
    line += `  ${percentText}`
    if (files) line += `  ${filesText}`
    line += `   ${style.dim(timeText + (left ? leftText : ''))}`
    return line
  }

  const used = displayWidth(assemble(0, true, true))
  const spare = room - used - 3
  if (spare >= BAR_MIN) {
    return fitWidth(assemble(Math.min(BAR_MAX, spare), true, true), room)
  }
  for (const [files, left] of [
    [true, true],
    [true, false],
    [false, false],
  ] as const) {
    const line = assemble(0, files, left)
    if (displayWidth(line) <= room) return line
  }
  return fitWidth(assemble(0, false, false), room)
}

/**
 * The line a run ends with: the counts, the files and the time, no bar.
 * @beta
 */
export function finalStatusLine(
  input: StatusInput,
  columns: number,
  glyphs: Glyphs,
  style: Style,
): string {
  const line = `${counts(input, glyphs, style)}  ${groupDigits(input.filesDone)} of ${groupDigits(input.filesTotal)} files  ${style.dim(clock(input.elapsedMs))}`
  return fitWidth(line, Math.max(1, columns - 1))
}
