// A finished file's line (its mark, path, what happened in it and how long it took) and the dim
// console lines under it. Pure: built once, in the first frame after the file ended.

import type { Style } from '../../style.ts'
import type { ConsoleEntry } from '../model/state.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { cleanText } from '../terminal/sanitize.ts'
import { displayWidth, fitWidth, fitWidthLeft } from '../terminal/width.ts'
import { fileTime, groupDigits } from './format.ts'

/**
 * What a finished file's line says.
 * @beta
 */
export interface FileLineInput {
  readonly path: string
  /** The project's name, put before the path when there is one. */
  readonly project: string
  readonly state: 'pass' | 'fail' | 'skip'
  /** Tests that ended in the file. */
  readonly tests: number
  readonly failed: number
  readonly skipped: number
  readonly durationMs: number
}

/** The least of a path worth keeping before the tail gives way. */
const MIN_PATH_COLUMNS = 12

/** The most console lines printed under a file. */
export const MAX_CONSOLE_LINES = 20

function plural(count: number, noun: string): string {
  return `${groupDigits(count)} ${noun}${count === 1 ? '' : 's'}`
}

function detail(input: FileLineInput): string {
  switch (input.state) {
    case 'fail':
      return input.failed > 0
        ? `${groupDigits(input.failed)} of ${groupDigits(input.tests)} failed`
        : 'failed to run'
    case 'skip':
      return input.tests > 0 ? `${plural(input.tests, 'test')} skipped` : 'skipped'
    default:
      return input.skipped > 0
        ? `${plural(input.tests, 'test')} · ${groupDigits(input.skipped)} skipped`
        : plural(input.tests, 'test')
  }
}

/**
 * The finished file's line, at most `columns - 1` columns wide; a long path is cut from the left.
 * @beta
 */
export function fileLine(
  input: FileLineInput,
  columns: number,
  glyphs: Glyphs,
  style: Style,
): string {
  const mark =
    input.state === 'fail' ? glyphs.fail : input.state === 'skip' ? glyphs.skipped : glyphs.pass
  const label = cleanText(
    input.project === '' ? input.path : `${input.project} ${input.path}`,
    false,
  )
  const room = Math.max(1, columns - 1)
  const time = fileTime(input.durationMs)
  // The whole tail when the path keeps a useful part of itself, else only the time, else none.
  const tails = [` · ${detail(input)} · ${time}`, ` · ${time}`, '']
  let tail = ''
  let pathRoom = 1
  for (const candidate of tails) {
    tail = candidate
    pathRoom = Math.max(1, room - displayWidth(mark) - 1 - displayWidth(candidate))
    if (pathRoom >= Math.min(MIN_PATH_COLUMNS, displayWidth(label))) break
  }
  const shown = displayWidth(label) <= pathRoom ? label : fitWidthLeft(label, pathRoom)
  const path = input.state === 'fail' ? style.red(shown) : shown
  return `${mark} ${path}${style.dim(tail)}`
}

/**
 * The console writes of a file as dim lines under its line, at most `MAX_CONSOLE_LINES`, then how
 * many more there were. A write the file made past the entries the state keeps counts as one line.
 * @beta
 */
export function consoleLines(
  entries: readonly ConsoleEntry[],
  omitted: number,
  columns: number,
  style: Style,
  colour: boolean,
): string[] {
  const lines: string[] = []
  let more = omitted
  const room = Math.max(1, columns - 1 - 3)
  for (const entry of entries) {
    const cleaned = cleanText(entry.text, colour)
    const text = cleaned.endsWith('\n') ? cleaned.slice(0, -1) : cleaned
    for (const line of text.split('\n')) {
      if (lines.length >= MAX_CONSOLE_LINES) {
        more++
        continue
      }
      const shown = displayWidth(line) > room ? fitWidth(line, room) : line
      lines.push(`   ${style.dim(shown)}`)
    }
  }
  if (more > 0)
    lines.push(`   ${style.dim(`… ${groupDigits(more)} more line${more === 1 ? '' : 's'}`)}`)
  return lines
}
