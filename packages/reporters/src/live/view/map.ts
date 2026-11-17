// The `--map` view: one cell per file, a row per folder, wrapped at the width. The emoji set draws
// squares (`🟩🟥🟨⬜`); the other sets draw a letter in colour (`.` `X` `s` `t`), so the outcome
// reads without colour too. A legend line says which is which. Pure, built once at `run:end`.

import {
  type FileKind,
  type Folder,
  type FolderFile,
  folderLabel,
} from '../../internal/views/folders.ts'
import type { Style } from '../../style.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { oneLine } from '../terminal/sanitize.ts'
import { displayWidth, fitWidth, fitWidthLeft } from '../terminal/width.ts'

/** The columns between a folder's label and its cells. */
const GAP = 2
/** The share of the width the labels may take, so the cells keep most of it. */
const LABEL_SHARE = 0.4

/** The cell of a kind, in its colour where the cell is a letter (an emoji square has its own). */
function cellOf(kind: FileKind, glyphs: Glyphs, style: Style): string {
  const { cell } = glyphs
  const emoji = glyphs.set === 'emoji'
  switch (kind) {
    case 'fail':
      return emoji ? cell.fail : style.red(cell.fail)
    case 'skip':
      return emoji ? cell.skipped : style.yellow(cell.skipped)
    case 'todo':
      return emoji ? cell.todo : style.dim(cell.todo)
    default:
      return emoji ? cell.pass : style.green(cell.pass)
  }
}

/**
 * The legend: what each cell means.
 * @beta
 */
export function mapLegend(glyphs: Glyphs, style: Style): string {
  const entries: readonly (readonly [FileKind, string])[] = [
    ['pass', 'pass'],
    ['fail', 'fail'],
    ['skip', 'skip'],
    ['todo', 'todo'],
  ]
  return entries
    .map(([kind, word]) => `${cellOf(kind, glyphs, style)} ${style.dim(word)}`)
    .join('  ')
}

/**
 * The map's lines, none wider than `columns - 1`: the legend, then a row per folder, its cells in
 * path order, wrapped under the label when they do not fit. Labels are cut from the left. No
 * folders, no lines: a run with no file has no map.
 * @beta
 */
export function mapLines(
  folders: readonly Folder<FolderFile>[],
  columns: number,
  glyphs: Glyphs,
  style: Style,
): string[] {
  if (folders.length === 0) return []
  const room = Math.max(1, columns - 1)
  const labels = folders.map((folder) => oneLine(folderLabel(folder)))
  const widest = labels.reduce((most, label) => Math.max(most, displayWidth(label)), 0)
  const labelWidth = Math.min(widest, Math.max(1, Math.floor(room * LABEL_SHARE)))
  // A cell is as wide as the widest of the set's, so a row of any mix of outcomes fits.
  const cellWidth = Math.max(1, ...Object.values(glyphs.cell).map((cell) => displayWidth(cell)))
  const perRow = Math.max(1, Math.floor((room - labelWidth - GAP) / cellWidth))
  const indent = ' '.repeat(labelWidth + GAP)
  const lines = [fitWidth(mapLegend(glyphs, style), room)]
  folders.forEach((folder, index) => {
    const label = labels[index] as string
    const shown = displayWidth(label) > labelWidth ? fitWidthLeft(label, labelWidth) : label
    const lead = `${style.bold(shown)}${' '.repeat(labelWidth - displayWidth(shown) + GAP)}`
    // A folder always has a file, so there is always a first row.
    for (let from = 0; from < folder.files.length; from += perRow) {
      const cells = folder.files
        .slice(from, from + perRow)
        .map((file) => cellOf(file.kind, glyphs, style))
        .join('')
      // Cut like the legend: whatever the glyphs measure, no row is wider than the terminal less one.
      lines.push(fitWidth(`${from === 0 ? lead : indent}${cells}`, room))
    }
  })
  return lines
}
