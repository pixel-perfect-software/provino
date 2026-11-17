// The `--tree` view: the run folder by folder, each folder's files under it, and the files that did
// not fully pass opened down to their failed tests. Pure: the folders (`groupByFolder` over the
// store's `TreeFile`s), the width, the glyphs and the style in, lines out. Built once, at `run:end`.
//
// - A folder is a heading with its totals. A file that fully passed is one folded row with its test
//   count; any other file opens, and so does each suite of it that holds a failure. A suite with no
//   failure is one folded row, with its count and time.
// - Under an open suite: its suites and its failed tests in declaration order, each failed test
//   with the first line of its error, then one row for the tests that are not listed.
// - The time of each row is right-aligned in the last column, measured with `displayWidth`.

import { basenameOf, type FileKind, type Folder } from '../../internal/views/folders.ts'
import type { Style } from '../../style.ts'
import type { NodeState, TreeFile, TreeNode, TreeRest } from '../model/tree-store.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { cleanText } from '../terminal/sanitize.ts'
import { displayWidth, fitWidth, fitWidthLeft } from '../terminal/width.ts'
import { fileDetail } from './file-line.ts'
import { fileTime, groupDigits } from './format.ts'

/** What one row says; `row` fits it to the width. */
interface Row {
  /** The tree's guides to the row, plain text, drawn dim. */
  readonly guide: string
  /** A status glyph, or `''` for a row with none. */
  readonly mark: string
  readonly label: string
  /** After the label, dim: starts with ` · `, or is empty. */
  readonly detail: string
  /** Right-aligned in the last column; `''` for none. */
  readonly time: string
  /** The label's colour. Default: none. */
  readonly paint?: (text: string) => string
  /** Cut a label that does not fit from its left (a path), not its right. */
  readonly cutLeft?: true
}

interface Context {
  /** The columns a row may fill: one less than the terminal's, so no row wraps. */
  readonly room: number
  readonly glyphs: Glyphs
  readonly style: Style
  readonly out: string[]
}

/** A row that draws its guide, mark and the rest of its place in the tree. */
type Item = (guide: string, childIndent: string) => void

/** A name or a message on one line, with no control characters. */
function oneLine(text: string): string {
  return cleanText(text, false).replace(/[\n\r\t]+/g, ' ')
}

function plural(count: number, noun: string): string {
  return `${groupDigits(count)} ${noun}${count === 1 ? '' : 's'}`
}

function markOf(state: NodeState | FileKind, glyphs: Glyphs): string {
  switch (state) {
    case 'fail':
      return glyphs.fail
    case 'skip':
      return glyphs.skipped
    case 'todo':
      return glyphs.todo
    default:
      return glyphs.pass
  }
}

/** The row as one line, at most `room` columns, its time against the right edge. */
function row(input: Row, ctx: Context): string {
  const { room, style } = ctx
  const label = oneLine(input.label)
  const timeWidth = input.time === '' ? 0 : displayWidth(input.time)
  const left = timeWidth === 0 ? room : room - timeWidth - 1
  const fixed = displayWidth(input.guide) + (input.mark === '' ? 0 : displayWidth(input.mark) + 1)
  const labelWidth = displayWidth(label)
  let shownLabel = label
  let shownDetail = input.detail
  if (fixed + labelWidth + displayWidth(input.detail) > left) {
    if (fixed + labelWidth <= left) shownDetail = fitWidth(input.detail, left - fixed - labelWidth)
    else {
      const labelRoom = Math.max(1, left - fixed)
      shownLabel =
        input.cutLeft === true ? fitWidthLeft(label, labelRoom) : fitWidth(label, labelRoom)
      shownDetail = ''
    }
  }
  const used = fixed + displayWidth(shownLabel) + displayWidth(shownDetail)
  const pad = timeWidth === 0 ? 0 : Math.max(1, room - used - timeWidth)
  const dim = (text: string): string => (text === '' ? '' : style.dim(text))
  const text =
    dim(input.guide) +
    (input.mark === '' ? '' : `${input.mark} `) +
    (input.paint === undefined ? shownLabel : input.paint(shownLabel)) +
    dim(shownDetail) +
    ' '.repeat(pad) +
    dim(input.time)
  return used + pad + timeWidth > room ? fitWidth(text, room) : text
}

/** Dim lines under a row: the first line of an error, aligned under the row's label. */
function messageLines(
  messages: readonly string[],
  childIndent: string,
  mark: string,
  ctx: Context,
): void {
  const margin = ' '.repeat(mark === '' ? 0 : displayWidth(mark) + 1)
  for (const message of messages) {
    ctx.out.push(ctx.style.dim(fitWidth(`${childIndent}${margin}${oneLine(message)}`, ctx.room)))
  }
}

/** The rows of `items`, the last drawn with the closing guide. */
function emit(items: readonly Item[], indent: string, ctx: Context): void {
  const { tree } = ctx.glyphs
  items.forEach((item, index) => {
    const last = index === items.length - 1
    item(indent + (last ? tree.last : tree.branch), indent + (last ? tree.blank : tree.pipe))
  })
}

/** The one row for the tests of a suite that are not listed. */
function restItem(rest: TreeRest, ctx: Context): Item {
  return (guide) => {
    const parts: string[] = []
    if (rest.passed > 0)
      parts.push(`${groupDigits(rest.passed)} more test${rest.passed === 1 ? '' : 's'}`)
    if (rest.skipped > 0) parts.push(`${groupDigits(rest.skipped)} skipped`)
    if (rest.todo > 0) parts.push(`${groupDigits(rest.todo)} todo`)
    const state: NodeState = rest.passed > 0 ? 'pass' : rest.skipped > 0 ? 'skip' : 'todo'
    ctx.out.push(
      row(
        {
          guide,
          mark: markOf(state, ctx.glyphs),
          label: parts[0] ?? '',
          detail: parts
            .slice(1)
            .map((part) => ` · ${part}`)
            .join(''),
          time: fileTime(rest.durationMs),
        },
        ctx,
      ),
    )
  }
}

function moreFailedItem(count: number, ctx: Context): Item {
  return (guide) => {
    ctx.out.push(
      row(
        {
          guide,
          mark: '',
          label: `… ${plural(count, 'more failed test')}`,
          detail: '',
          time: '',
          paint: ctx.style.dim,
        },
        ctx,
      ),
    )
  }
}

function nodeItem(node: TreeNode, ctx: Context): Item {
  return (guide, childIndent) => {
    const mark = markOf(node.state, ctx.glyphs)
    if (node.kind === 'test') {
      ctx.out.push(
        row(
          {
            guide,
            mark,
            label: node.name,
            detail: '',
            time: fileTime(node.durationMs),
            paint: ctx.style.red,
          },
          ctx,
        ),
      )
      messageLines(node.message === undefined ? [] : [node.message], childIndent, mark, ctx)
      return
    }
    if (node.state !== 'fail') {
      const detail = fileDetail({
        state: node.state === 'skip' ? 'skip' : 'pass',
        tests: node.tests,
        failed: 0,
        skipped: node.skipped,
      })
      ctx.out.push(
        row(
          {
            guide,
            mark,
            label: node.name,
            detail: ` · ${detail}`,
            time: fileTime(node.durationMs),
          },
          ctx,
        ),
      )
      return
    }
    ctx.out.push(
      row(
        {
          guide,
          mark,
          label: node.name,
          detail:
            node.failed > 0
              ? ` · ${groupDigits(node.failed)} of ${groupDigits(node.tests)} failed`
              : ' · failed',
          time: fileTime(node.durationMs),
          paint: ctx.style.red,
        },
        ctx,
      ),
    )
    messageLines(node.message === undefined ? [] : [node.message], childIndent, mark, ctx)
    const items = node.children.map((child) => nodeItem(child, ctx))
    if (node.rest !== undefined) items.push(restItem(node.rest, ctx))
    emit(items, childIndent, ctx)
  }
}

function fileItem(file: TreeFile, ctx: Context): Item {
  return (guide, childIndent) => {
    const mark = markOf(file.kind, ctx.glyphs)
    const detail = fileDetail({
      state: file.kind === 'fail' ? 'fail' : file.kind === 'skip' ? 'skip' : 'pass',
      tests: file.tests,
      failed: file.failed,
      skipped: file.skipped,
    })
    ctx.out.push(
      row(
        {
          guide,
          mark,
          label: basenameOf(file.path),
          detail: ` · ${detail}`,
          time: fileTime(file.durationMs),
          ...(file.kind === 'fail' ? { paint: ctx.style.red } : {}),
        },
        ctx,
      ),
    )
    const { open } = file
    if (open === undefined) return
    messageLines(open.messages, childIndent, mark, ctx)
    const items = open.children.map((child) => nodeItem(child, ctx))
    if (open.rest !== undefined) items.push(restItem(open.rest, ctx))
    if (open.moreFailed > 0) items.push(moreFailedItem(open.moreFailed, ctx))
    emit(items, childIndent, ctx)
  }
}

/** The folder's label: its project, then its directory with a closing slash (`src/cart/`, `./`). */
export function folderLabel(folder: Pick<Folder, 'project' | 'dir'>): string {
  const dir = folder.dir.endsWith('/') ? folder.dir : `${folder.dir}/`
  return folder.project === '' ? dir : `${folder.project} ${dir}`
}

/**
 * The tree's lines, none wider than `columns - 1`: each folder as a heading with its totals and the
 * time its files took, then its files.
 * @beta
 */
export function treeLines(
  folders: readonly Folder<TreeFile>[],
  columns: number,
  glyphs: Glyphs,
  style: Style,
): string[] {
  const ctx: Context = { room: Math.max(1, columns - 1), glyphs, style, out: [] }
  for (const folder of folders) {
    const failed = folder.filesFailed > 0
    const detail = [
      plural(folder.files.length, 'file'),
      plural(folder.tests, 'test'),
      ...(folder.failed > 0 ? [`${groupDigits(folder.failed)} failed`] : []),
    ]
    ctx.out.push(
      row(
        {
          guide: '',
          mark: failed ? glyphs.fail : glyphs.pass,
          label: folderLabel(folder),
          detail: ` · ${detail.join(' · ')}`,
          time: fileTime(folder.durationMs),
          paint: failed ? (text) => style.bold(style.red(text)) : style.bold,
          cutLeft: true,
        },
        ctx,
      ),
    )
    emit(
      folder.files.map((file) => fileItem(file, ctx)),
      '',
      ctx,
    )
  }
  return ctx.out
}
