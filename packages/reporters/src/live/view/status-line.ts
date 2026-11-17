// The footer's last line: the progress bar, the files done, the percent, the test counts and the
// time. It is a pure function of its inputs, so a frame rebuilds it only when they change. At a
// narrow width it drops the bar first, then the time left, then the file count; what is still too
// wide is cut at the end.

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
  /** `shard 2/3`, for a run that is one shard of several. */
  readonly shard?: string
}

/** The widest the bar gets, and the narrowest it is worth drawing. */
const BAR_MAX = 24
const BAR_MIN = 8

/** The counts: passed and failed always, skipped and todo when there are any. */
function counts(input: StatusInput, glyphs: Glyphs, style: Style): string {
  const failed = `${glyphs.fail} ${groupDigits(input.failed)}`
  const parts = [
    style.green(`${glyphs.pass} ${groupDigits(input.passed)}`),
    input.failed > 0 ? style.red(failed) : failed,
  ]
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
 * The status line, at most `columns - 1` columns wide: `██░░  23/669 files  3%   ✅ 355  ❌ 0
 * 34.7s · ~55s left`.
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
  const countsText = counts(input, glyphs, style)
  const percentText = `${percent}%`
  const filesText = `${groupDigits(input.filesDone)}/${groupDigits(input.filesTotal)} files${input.shard === undefined ? '' : ` · ${input.shard}`}`
  const timeText = clock(input.elapsedMs)
  const leftText = input.leftMs === undefined ? '' : ` · ~${roughDuration(input.leftMs)} left`

  const assemble = (cells: number, files: boolean, left: boolean): string => {
    const progress: string[] = []
    if (cells > 0) {
      progress.push(bar(input.filesDone, input.filesTotal, cells, glyphs, style, input.failed > 0))
    }
    if (files) progress.push(filesText)
    progress.push(percentText)
    return `${progress.join('  ')}   ${countsText}   ${style.dim(timeText + (left ? leftText : ''))}`
  }

  // The bar's own width, and the two spaces after it.
  const used = displayWidth(assemble(0, true, true))
  const spare = room - used - 2
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
