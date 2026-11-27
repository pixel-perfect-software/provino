// @provino/snapshot/inline: the native inline snapshot writer (B28 Phase 7, D211, D214). The
// coordinator loads it once per run (`snapshot.inline.writer`, `nativeSnapshotPolicy`) and hands it
// each test file's edits after that file ends, as it does a dialect's writer (D113).
//
// It finds each edit's call as jest-snapshot 30.5.2's `traverseAst` does (`utils.ts` L367-L418: a
// call whose callee is `x.name`, by the line and column of `name`, or, for a stack the neutral
// `settlementCheck: 'at-read'` took at `x.resolves`/`x.rejects`, by where that read is; two edits for
// one call, or an edit with no call, fail the file), and puts the snapshot in as a template literal escaped with
// Jest's `escapeBacktickString`, replacing the call's first template or string argument
// or appended after its last. Where Jest reprints the whole call with Babel's generator
// (`retainLines`), this splices the template into the text and leaves the rest of the call as it was
// (`speed`: no Babel, which the native runtime bans, and no reprint), so a call Babel would lay out
// again (a callback's body, an object over several lines, a comment inside the call) keeps its own
// layout: DIVERGENCES, "DV: Babel reprint". There is no formatter (the native slice's `formatter` is
// `none`), and Jest writes the snapshot at column 0 when it has none, so this does too.
//
// Oxc's parser is imported the first time there is something to write: a run that writes no inline
// snapshot never loads it.
import { readFile } from 'node:fs/promises'
import type {
  InlineSnapshotEdit,
  InlineSnapshotWriteOptions,
  InlineSnapshotWriter,
  InlineSnapshotWriterFactory,
} from '@provino/types'
import type { ParserOptions } from 'oxc-parser'
import { SnapshotError } from '../errors.ts'
import { printBacktickString } from '../text.ts'
import { writeFileAtomically } from '../write-atomically.ts'

/** What this writer reads of a parsed node: Oxc's ESTree nodes carry UTF-16 offsets. */
interface SpanNode {
  readonly type: string
  readonly start: number
  readonly end: number
}

/** A call whose callee is `x.name`, with `name` an identifier and not computed. */
interface MatcherCall extends SpanNode {
  /** Where the matcher's name starts. */
  readonly nameStart: number
  /**
   * Under `x.resolves.name()` or `x.rejects.name()`, the offsets from the end of `x` to the start
   * of `resolves`: where a stack taken as `.resolves` is read points (`expect.settlementCheck`
   * `at-read`, the neutral value), rather than at `name` as Jest's frame does.
   */
  readonly read?: { readonly from: number; readonly to: number }
  readonly arguments: readonly SpanNode[]
}

/** One change to the source: `text` in place of `[start, end)`. */
interface Splice {
  readonly start: number
  readonly end: number
  readonly text: string
}

type Parse = typeof import('oxc-parser').parse

function isSpanNode(value: unknown): value is SpanNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'type') === 'string' &&
    typeof Reflect.get(value, 'start') === 'number' &&
    typeof Reflect.get(value, 'end') === 'number'
  )
}

/**
 * The call `node` is, when its callee is a member access by an identifier and it is one an edit
 * points at: `wanted` holds the offsets the edits name, and a call no offset reaches is not built.
 */
function matcherCall(node: SpanNode, wanted: ReadonlySet<number>): MatcherCall | undefined {
  if (node.type !== 'CallExpression') return undefined
  const callee: unknown = Reflect.get(node, 'callee')
  if (!isSpanNode(callee) || callee.type !== 'MemberExpression') return undefined
  if (Reflect.get(callee, 'computed') === true) return undefined
  const property: unknown = Reflect.get(callee, 'property')
  if (!isSpanNode(property) || property.type !== 'Identifier') return undefined
  const read = promiseRead(Reflect.get(callee, 'object'))
  if (!wanted.has(property.start) && !(read !== undefined && reachesRead(read, wanted))) {
    return undefined
  }
  const args: unknown = Reflect.get(node, 'arguments')
  return {
    type: node.type,
    start: node.start,
    end: node.end,
    nameStart: property.start,
    ...(read === undefined ? {} : { read }),
    arguments: Array.isArray(args) ? args.filter(isSpanNode) : [],
  }
}

/** Whether one of the `wanted` offsets lies in the promise read's offsets. */
function reachesRead(
  read: { readonly from: number; readonly to: number },
  wanted: ReadonlySet<number>,
): boolean {
  for (const at of wanted) if (at >= read.from && at <= read.to) return true
  return false
}

/** For `x.resolves` or `x.rejects`, the offsets from the end of `x` to the start of the name. */
function promiseRead(object: unknown): MatcherCall['read'] {
  if (!isSpanNode(object) || object.type !== 'MemberExpression') return undefined
  if (Reflect.get(object, 'computed') === true) return undefined
  const subject: unknown = Reflect.get(object, 'object')
  const property: unknown = Reflect.get(object, 'property')
  if (!isSpanNode(subject) || !isSpanNode(property) || property.type !== 'Identifier') {
    return undefined
  }
  const name: unknown = Reflect.get(property, 'name')
  if (name !== 'resolves' && name !== 'rejects') return undefined
  return { from: subject.end, to: property.start }
}

/** The matcher calls of a source: by where each name starts, and by the offsets of its promise read. */
interface CallIndex {
  readonly byName: Map<number, MatcherCall>
  readonly byRead: Map<number, MatcherCall>
}

/** The matcher calls of `program` that the `wanted` offsets reach. */
function indexCalls(program: unknown, wanted: ReadonlySet<number>): CallIndex {
  const byName = new Map<number, MatcherCall>()
  const byRead = new Map<number, MatcherCall>()
  const stack: unknown[] = [program]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value !== 'object' || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    if (isSpanNode(value)) {
      const call = matcherCall(value, wanted)
      if (call !== undefined) {
        byName.set(call.nameStart, call)
        if (call.read !== undefined) {
          for (const at of wanted)
            if (at >= call.read.from && at <= call.read.to) byRead.set(at, call)
        }
      }
    }
    for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) stack.push(child)
    }
  }
  return { byName, byRead }
}

/**
 * The offset each line starts at, line 1 first, with Babel's line breaks (CR LF, CR, LF, and the
 * line and paragraph separators), as the edit's line counts them.
 */
function lineStarts(source: string): number[] {
  const starts = [0]
  for (const match of source.matchAll(/\r\n?|[\n\u{2028}\u{2029}]/gu)) {
    starts.push(match.index + match[0].length)
  }
  return starts
}

/** The parser's language for a file, by its extension: JSX is allowed in every JavaScript file. */
function langOf(file: string): NonNullable<ParserOptions['lang']> {
  if (/\.tsx$/.test(file)) return 'tsx'
  if (/\.[cm]?ts$/.test(file)) return 'ts'
  return 'jsx'
}

/** Where an edit's template goes in `call`: over its first template or string, or after its arguments. */
function spliceFor(call: MatcherCall, source: string, snapshot: string): Splice {
  const template = printBacktickString(snapshot)
  const existing = call.arguments.find(
    (arg) =>
      arg.type === 'TemplateLiteral' ||
      (arg.type === 'Literal' && typeof Reflect.get(arg, 'value') === 'string'),
  )
  if (existing !== undefined) return { start: existing.start, end: existing.end, text: template }
  const last = call.arguments.at(-1)
  if (last !== undefined) return { start: last.end, end: last.end, text: `, ${template}` }
  // No argument: the template goes before the call's closing parenthesis.
  const close = source.lastIndexOf(')', call.end - 1)
  return { start: close, end: close, text: template }
}

/** One source file's text with every edit's snapshot in it. */
async function withSnapshots(
  parse: Parse,
  file: string,
  source: string,
  edits: readonly InlineSnapshotEdit[],
): Promise<string> {
  const parsed = await parse(file, source, { lang: langOf(file), sourceType: 'unambiguous' })
  const [error] = parsed.errors
  if (error !== undefined) {
    throw new SnapshotError(
      'SNAPSHOT_INLINE_PARSE',
      `Inline snapshots could not be written into ${file}: it does not parse (${error.message}).`,
    )
  }
  const starts = lineStarts(source)
  const offsets = edits.map((edit) => {
    const lineStart = starts[edit.line - 1]
    return lineStart === undefined ? undefined : lineStart + edit.column
  })
  const calls = indexCalls(
    parsed.program,
    new Set(offsets.filter((at): at is number => at !== undefined)),
  )
  const byCall = new Map<MatcherCall, [InlineSnapshotEdit, ...InlineSnapshotEdit[]]>()
  for (const [index, edit] of edits.entries()) {
    const at = offsets[index]
    // Jest's rule first (the matcher's name), then a stack taken at a `.resolves`/`.rejects` read.
    const call = at === undefined ? undefined : (calls.byName.get(at) ?? calls.byRead.get(at))
    if (call === undefined) {
      throw new SnapshotError(
        'SNAPSHOT_INLINE_NOT_FOUND',
        `Inline snapshots could not be written into ${file}: no matcher call at line ${edit.line}, column ${edit.column + 1}.`,
      )
    }
    const forCall = byCall.get(call)
    if (forCall === undefined) byCall.set(call, [edit])
    else forCall.push(edit)
  }
  const splices: Splice[] = []
  for (const [call, forCall] of byCall) {
    const [edit, second] = forCall
    if (second !== undefined) {
      throw new SnapshotError(
        'SNAPSHOT_INLINE_SAME_CALL',
        `Inline snapshots could not be written into ${file}: the call at line ${edit.line} took ${forCall.length} snapshots, and one call can hold only one.`,
      )
    }
    splices.push(spliceFor(call, source, edit.snapshot))
  }
  // In source order, cutting the text once: each piece up to a splice, then what it puts.
  splices.sort((a, b) => a.start - b.start)
  const pieces: string[] = []
  let from = 0
  for (const { start, end, text } of splices) {
    pieces.push(source.slice(from, start), text)
    from = end
  }
  pieces.push(source.slice(from))
  return pieces.join('')
}

/**
 * The native inline snapshot writer (`snapshot.inline.writer` of `nativeSnapshotPolicy`). Each
 * returned writer imports Oxc's parser on its first write and keeps it.
 * @public
 */
export const nativeInlineSnapshotWriter: InlineSnapshotWriterFactory = (): InlineSnapshotWriter => {
  let parser: Promise<Parse> | undefined
  return async (
    edits: readonly InlineSnapshotEdit[],
    _options: InlineSnapshotWriteOptions,
  ): Promise<readonly string[]> => {
    if (edits.length === 0) return []
    parser ??= import('oxc-parser').then((oxc) => oxc.parse)
    const parse = await parser
    const byFile = new Map<string, InlineSnapshotEdit[]>()
    for (const edit of edits) {
      const forFile = byFile.get(edit.file)
      if (forFile === undefined) byFile.set(edit.file, [edit])
      else forFile.push(edit)
    }
    for (const [file, fileEdits] of byFile) {
      const source = await readFile(file, 'utf8')
      const next = await withSnapshots(parse, file, source, fileEdits)
      // Through a temp file and a rename, as a `.snap` file is: a failed or cut-short write never
      // leaves the user's file empty or half written.
      if (next !== source) writeFileAtomically(file, next)
    }
    return []
  }
}
