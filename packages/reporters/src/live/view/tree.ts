// The `--tree` view: the run folder by folder, each folder's files under it, and the files that did
// not fully pass opened down to their failed tests. Pure: the folders (`groupByFolder` over the
// store's `TreeFile`s), the width, the glyphs and the style in, lines out. Built once, at `run:end`.
//
// - A folder is a heading with its totals. A file that fully passed is one folded row with its test
//   count; any other file opens, and so does each suite of it that holds a failure. A suite with no
//   failure is one folded row, with its count and time.
// - Under an open suite: its suites and its failed tests in declaration order, each failed test
//   with the first line of its error, then one row for the tests that are not listed.
// - The time of each row is right-aligned in the last column. Widths are measured once: a guide is
//   `GUIDE_WIDTH` columns a level, a mark's width is per kind (`Context.markWidths`), a row's label
//   and detail are measured once and again only when cut, and a time is ASCII.

import { posix } from 'node:path'
import {
  type FileKind,
  type Folder,
  folderDetail,
  folderLabel,
} from '../../internal/views/folders.ts'
import type { Style } from '../../style.ts'
import type { TreeFile, TreeNode, TreeRest } from '../model/tree-store.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { oneLine } from '../terminal/sanitize.ts'
import { displayWidth, fitWidth, fitWidthLeft } from '../terminal/width.ts'
import { fileDetail } from './file-line.ts'
import { fileTime, groupDigits, markOf, plural } from './format.ts'

/** The columns of one level of guides: every `Glyphs.tree` guide is this wide. */
const GUIDE_WIDTH = 3

/** What one row says; `row` fits it to the width. */
interface Row {
  /** The tree's guides to the row, plain text, drawn dim. */
  readonly guide: string
  /** The columns of `guide`: `GUIDE_WIDTH` a level. */
  readonly guideWidth: number
  /** The row's status mark, or `undefined` for a row with none. */
  readonly kind?: FileKind
  readonly label: string
  /** After the label, dim: starts with ` · `, or is empty. */
  readonly detail: string
  /** Right-aligned in the last column; `''` for none. ASCII. */
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
  /** The columns of each kind's mark: one width in the emoji and unicode sets, not in ascii (`ok`, `x`). */
  readonly markWidths: Readonly<Record<FileKind, number>>
  readonly out: string[]
}

/** A row that draws its guide, mark and the rest of its place in the tree; `depth` counts its guides. */
type Item = (guide: string, childIndent: string, depth: number) => void

/** The row as one line, at most `room` columns, its time against the right edge. */
function row(input: Row, ctx: Context): string {
  const { room, style } = ctx
  const label = oneLine(input.label)
  const timeWidth = input.time.length
  const left = timeWidth === 0 ? room : room - timeWidth - 1
  const fixed = input.guideWidth + (input.kind === undefined ? 0 : ctx.markWidths[input.kind] + 1)
  let labelWidth = displayWidth(label)
  let detailWidth = displayWidth(input.detail)
  let shownLabel = label
  let shownDetail = input.detail
  if (fixed + labelWidth + detailWidth > left) {
    if (fixed + labelWidth <= left) {
      shownDetail = fitWidth(input.detail, left - fixed - labelWidth)
      detailWidth = displayWidth(shownDetail)
    } else {
      const labelRoom = Math.max(1, left - fixed)
      shownLabel =
        input.cutLeft === true ? fitWidthLeft(label, labelRoom) : fitWidth(label, labelRoom)
      labelWidth = displayWidth(shownLabel)
      shownDetail = ''
      detailWidth = 0
    }
  }
  const used = fixed + labelWidth + detailWidth
  const pad = timeWidth === 0 ? 0 : Math.max(1, room - used - timeWidth)
  const dim = (text: string): string => (text === '' ? '' : style.dim(text))
  const text =
    dim(input.guide) +
    (input.kind === undefined ? '' : `${markOf(input.kind, ctx.glyphs)} `) +
    (input.paint === undefined ? shownLabel : input.paint(shownLabel)) +
    dim(shownDetail) +
    ' '.repeat(pad) +
    dim(input.time)
  return used + pad + timeWidth > room ? fitWidth(text, room) : text
}

/**
 * Dim lines under a row: the first lines of its errors, aligned under its label. `depth` is the
 * row's own (its `childIndent` is as wide as its guide). The message is fitted to what the prefix
 * leaves, so a plain message never takes the slow path through the prefix's box-drawing.
 */
function messageLines(
  messages: readonly string[],
  childIndent: string,
  depth: number,
  kind: FileKind,
  ctx: Context,
): void {
  const margin = ctx.markWidths[kind] + 1
  const prefix = childIndent + ' '.repeat(margin)
  const textRoom = ctx.room - depth * GUIDE_WIDTH - margin
  for (const message of messages) {
    ctx.out.push(
      ctx.style.dim(
        textRoom > 0 ? prefix + fitWidth(oneLine(message), textRoom) : fitWidth(prefix, ctx.room),
      ),
    )
  }
}

/** The rows of `items`, the last drawn with the closing guide; `depth` is the depth of `indent`. */
function emit(items: readonly Item[], indent: string, depth: number, ctx: Context): void {
  const { tree } = ctx.glyphs
  items.forEach((item, index) => {
    const last = index === items.length - 1
    item(
      indent + (last ? tree.last : tree.branch),
      indent + (last ? tree.blank : tree.pipe),
      depth + 1,
    )
  })
}

/** One row of text that stands for tests or suites left out: `… 12 more suites`. */
function moreItem(label: string, ctx: Context): Item {
  return (guide, _childIndent, depth) => {
    ctx.out.push(
      row(
        {
          guide,
          guideWidth: depth * GUIDE_WIDTH,
          label,
          detail: '',
          time: '',
          paint: ctx.style.dim,
        },
        ctx,
      ),
    )
  }
}

/** The one row for the tests of a suite that are not listed. */
function restItem(rest: TreeRest, ctx: Context): Item {
  return (guide, _childIndent, depth) => {
    const parts: string[] = []
    if (rest.passed > 0) parts.push(plural(rest.passed, 'more test'))
    if (rest.skipped > 0) parts.push(`${groupDigits(rest.skipped)} skipped`)
    if (rest.todo > 0) parts.push(`${groupDigits(rest.todo)} todo`)
    ctx.out.push(
      row(
        {
          guide,
          guideWidth: depth * GUIDE_WIDTH,
          kind: rest.passed > 0 ? 'pass' : rest.skipped > 0 ? 'skip' : 'todo',
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

/** The rows under an open suite or file: its children, the tests not listed, and what was left out. */
function childItems(
  children: readonly TreeNode[],
  rest: TreeRest | undefined,
  moreSuites: number,
  moreFailed: number,
  ctx: Context,
): Item[] {
  const items = children.map((child) => nodeItem(child, ctx))
  if (rest !== undefined) items.push(restItem(rest, ctx))
  if (moreSuites > 0) items.push(moreItem(`… ${plural(moreSuites, 'more suite')}`, ctx))
  if (moreFailed > 0) items.push(moreItem(`… ${plural(moreFailed, 'more failed test')}`, ctx))
  return items
}

function nodeItem(node: TreeNode, ctx: Context): Item {
  return (guide, childIndent, depth) => {
    const failed = node.state === 'fail'
    // A test says nothing after its name; a failed suite how many of its tests failed; a folded one its count.
    const detail =
      node.kind === 'test'
        ? ''
        : failed
          ? node.failed > 0
            ? ` · ${groupDigits(node.failed)} of ${groupDigits(node.tests)} failed`
            : ' · failed'
          : ` · ${fileDetail({ state: node.state, tests: node.tests, failed: 0, skipped: node.skipped })}`
    ctx.out.push(
      row(
        {
          guide,
          guideWidth: depth * GUIDE_WIDTH,
          kind: node.state,
          label: node.name,
          detail,
          time: fileTime(node.durationMs),
          ...(failed ? { paint: ctx.style.red } : {}),
        },
        ctx,
      ),
    )
    if (node.message !== undefined)
      messageLines([node.message], childIndent, depth, node.state, ctx)
    // Only an open suite lists what is below it; a failed test has nothing below it.
    if (failed && node.kind === 'suite') {
      emit(childItems(node.children, node.rest, node.moreSuites, 0, ctx), childIndent, depth, ctx)
    }
  }
}

function fileItem(file: TreeFile, ctx: Context): Item {
  return (guide, childIndent, depth) => {
    ctx.out.push(
      row(
        {
          guide,
          guideWidth: depth * GUIDE_WIDTH,
          kind: file.kind,
          label: posix.basename(file.path),
          detail: ` · ${fileDetail({ state: file.kind, tests: file.tests, failed: file.failed, skipped: file.skipped })}`,
          time: fileTime(file.durationMs),
          ...(file.kind === 'fail' ? { paint: ctx.style.red } : {}),
        },
        ctx,
      ),
    )
    const { open } = file
    if (open === undefined) return
    messageLines(open.messages, childIndent, depth, file.kind, ctx)
    emit(
      childItems(open.children, open.rest, open.moreSuites, open.moreFailed, ctx),
      childIndent,
      depth,
      ctx,
    )
  }
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
  const ctx: Context = {
    room: Math.max(1, columns - 1),
    glyphs,
    style,
    markWidths: {
      pass: displayWidth(glyphs.pass),
      fail: displayWidth(glyphs.fail),
      skip: displayWidth(glyphs.skipped),
      todo: displayWidth(glyphs.todo),
    },
    out: [],
  }
  for (const folder of folders) {
    const failed = folder.filesFailed > 0
    ctx.out.push(
      row(
        {
          guide: '',
          guideWidth: 0,
          kind: failed ? 'fail' : 'pass',
          label: folderLabel(folder),
          detail: ` · ${folderDetail(folder)}`,
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
      0,
      ctx,
    )
  }
  return ctx.out
}
