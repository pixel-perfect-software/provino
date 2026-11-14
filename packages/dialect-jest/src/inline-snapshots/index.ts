// @provino/dialect-jest/inline-snapshots: Jest 30.5.2's inline snapshot writer, rebuilt from
// jest-snapshot's `InlineSnapshots.ts` (`saveInlineSnapshots`, L45-L119), `utils.ts`
// (`processInlineSnapshotsWithBabel` L213-L285, `processPrettierAst` L287-L345, `indent`
// L137-L169, the grouping L347-L365, `traverseAst` L367-L418) and `worker.ts` (Prettier 3,
// L19-L74). The coordinator loads it once per run (`snapshot.inline.writer`) and hands it each
// source file's edits after the test file that recorded them ends (D113).
//
// The call is reprinted with Babel's generator (`retainLines`), exactly as Jest does, so a call
// over several lines comes out as Jest writes it (D122); Babel is loaded only here, when a
// snapshot is written. With the project's Prettier 3 the file is then formatted as Jest's worker
// formats it, through Prettier's public `format`, twice (D113): Jest's worker reindents the
// snapshots on Prettier's own AST (`__debug`); here they are reindented in the text, found with
// Babel. With Prettier 2 the file is written unformatted and the writer warns (a divergence).
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type {
  InlineSnapshotEdit,
  InlineSnapshotWriteOptions,
  InlineSnapshotWriter,
  InlineSnapshotWriterFactory,
} from '@provino/types'
import { type Babel, type BabelNode, babelFor } from './babel.ts'

/** `@jest/snapshot-utils`' `escapeBacktickString`. */
function escapeBacktickString(text: string): string {
  return text.replaceAll(/`|\\|\$\{/g, '\\$&')
}

/** jest-snapshot's `indent` (`utils.ts` L137-L169). */
function indent(snapshot: string, numIndents: number, indentation: string): string {
  const lines = snapshot.split('\n')
  // Prevent re-indentation of inline snapshots.
  if (lines.length >= 2 && lines[1]?.startsWith(indentation.repeat(numIndents + 1))) {
    return snapshot
  }
  return lines
    .map((line, index) => {
      // First line is either a 1-line snapshot or a blank line.
      if (index === 0) return line
      // The last line should be placed on the same level as the expect call.
      if (index === lines.length - 1) return indentation.repeat(numIndents) + line
      // Do not indent empty lines.
      if (line === '') return line
      // Not last line, indent one level deeper than expect call.
      return indentation.repeat(numIndents + 1) + line
    })
    .join('\n')
}

/** Parses a source file as jest-snapshot does (`utils.ts` L221-L262). */
function parse(babel: Babel, code: string, file: string, rootDir: string): BabelNode {
  // TypeScript projects may not have a babel config; make sure they can be parsed anyway.
  const presets = [babel.preset]
  const plugins: unknown[] = []
  if (/\.([cm]?ts|tsx)$/.test(file)) {
    plugins.push([
      babel.typescriptPlugin,
      { isTSX: file.endsWith('x') },
      // unique name to make sure Babel does not complain about a possible duplicate plugin.
      'TypeScript syntax plugin added by Jest snapshot',
    ])
  }
  let ast: BabelNode | null
  try {
    ast = babel.parseSync(code, { filename: file, plugins, presets, root: rootDir })
  } catch (error) {
    // attempt to recover from missing jsx plugin
    if (!(error instanceof Error) || !error.message.includes('@babel/plugin-syntax-jsx')) {
      throw error
    }
    const jsx = [babel.jsxPlugin, {}, 'JSX syntax plugin added by Jest snapshot']
    try {
      ast = babel.parseSync(code, {
        filename: file,
        plugins: [...plugins, jsx],
        presets,
        root: rootDir,
      })
    } catch {
      throw error
    }
  }
  if (ast === null) throw new Error(`jest-snapshot: Failed to parse ${file}`)
  return ast
}

/** The edits grouped by `line:column` of the matcher's name (`groupSnapshotsByFrame`). */
function groupByFrame(edits: readonly InlineSnapshotEdit[]): Map<string, InlineSnapshotEdit[]> {
  const groups = new Map<string, InlineSnapshotEdit[]>()
  for (const edit of edits) {
    // The edit's column is 0-based already (Jest's frame column minus one).
    const key = `${edit.line}:${edit.column}`
    groups.set(key, [...(groups.get(key) ?? []), edit])
  }
  return groups
}

/** Whether a call's callee is `x.name` with `name` an identifier and not computed. */
function memberCallee(node: BabelNode): { property: BabelNode; callee: BabelNode } | undefined {
  if (node.type !== 'CallExpression') return undefined
  const { callee } = node
  if (callee?.type !== 'MemberExpression') return undefined
  const { property } = callee
  if (property?.type !== 'Identifier') return undefined
  return { property, callee }
}

/**
 * jest-snapshot's `traverseAst` (`utils.ts` L367-L418): finds each edit's call by its frame, puts
 * the snapshot in as a template literal (replacing the first template or string argument, or
 * appending), and returns the call node of each edit and the matcher names in order.
 */
function placeEdits(
  babel: Babel,
  edits: readonly InlineSnapshotEdit[],
  ast: BabelNode,
): { readonly nodes: Map<InlineSnapshotEdit, BabelNode>; readonly names: string[] } {
  const grouped = groupByFrame(edits)
  const remaining = new Set(edits.map(({ snapshot }) => snapshot))
  const nodes = new Map<InlineSnapshotEdit, BabelNode>()
  const names: string[] = []
  babel.traverseFast(ast, (node) => {
    const member = memberCallee(node)
    if (member === undefined || member.property.loc == null) return
    const { line, column } = member.property.loc.start
    const forFrame = grouped.get(`${line}:${column}`)
    if (forFrame === undefined) return
    if (forFrame.length > 1) {
      throw new Error('Jest: Multiple inline snapshots for the same call are not supported.')
    }
    const [edit] = forFrame
    if (edit === undefined) return
    nodes.set(edit, node)
    names.push(member.property.name ?? '')
    const args = node.arguments ?? []
    const index = args.findIndex(
      ({ type }) => type === 'TemplateLiteral' || type === 'StringLiteral',
    )
    remaining.delete(edit.snapshot)
    const replacement = babel.templateLiteral(
      [babel.templateElement({ raw: escapeBacktickString(edit.snapshot) })],
      [],
    )
    if (index === -1) args.push(replacement)
    else args[index] = replacement
  })
  if (remaining.size > 0) throw new Error("Jest: Couldn't locate all inline snapshots.")
  return { nodes, names }
}

/**
 * `processInlineSnapshotsWithBabel`: the source with every edit's call reprinted, substituted from
 * the end of the source backwards so the offsets stay true. Jest substitutes in the order its
 * edits were recorded (`reduceRight` over them): the same when they were recorded top to bottom,
 * and a corrupted file when they weren't (a helper defined above its callers records its call
 * after theirs). Here the position decides, never the recording order.
 */
function withSnapshots(
  babel: Babel,
  edits: readonly InlineSnapshotEdit[],
  file: string,
  source: string,
  rootDir: string,
): { readonly text: string; readonly names: readonly string[] } {
  const ast = parse(babel, source, file, rootDir)
  const { nodes, names } = placeEdits(babel, edits, ast)
  const startOf = (edit: InlineSnapshotEdit): number => nodes.get(edit)?.start ?? -1
  const fromTheEnd = [...edits].sort((a, b) => startOf(b) - startOf(a))
  const text = fromTheEnd.reduce((sofar, edit) => {
    const node = nodes.get(edit)
    if (node === undefined || typeof node.start !== 'number' || typeof node.end !== 'number') {
      throw new Error('Jest: no snapshot insert location found')
    }
    // A hack to prevent unexpected line breaks in the generated code
    if (node.loc != null) node.loc.end.line = node.loc.start.line
    return (
      sofar.slice(0, node.start) +
      babel.generate(node, { retainLines: true }).code.trim() +
      sofar.slice(node.end)
    )
  }, source)
  return { text, names }
}

/** What this writer uses of Prettier 3's public API. */
interface Prettier3 {
  readonly version: string
  resolveConfig(file: string, options: { editorconfig: boolean }): Promise<PrettierConfig | null>
  getFileInfo(file: string): Promise<{ readonly inferredParser: string | null }>
  format(text: string, options: PrettierConfig): Promise<string>
}

type PrettierConfig = Readonly<Record<string, unknown>>

function isPrettier(value: unknown): value is Prettier3 {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'version') === 'string' &&
    typeof Reflect.get(value, 'format') === 'function'
  )
}

/** The project's Prettier, or `undefined` when it isn't there (Jest ignores `MODULE_NOT_FOUND`). */
function loadPrettier(prettierPath: string): Prettier3 | undefined {
  let module: unknown
  try {
    module = createRequire(import.meta.url)(prettierPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
  return isPrettier(module) ? module : undefined
}

/**
 * Reindents each matcher's template to its call, as `processPrettierAst` does on Prettier's AST
 * (`utils.ts` L287-L345, with `keepNode`): the column of an `await` parent, else the callee's, in
 * units of `tabWidth` spaces (1 when the config has none) or of tabs (2 columns each).
 */
function reindented(
  babel: Babel,
  text: string,
  file: string,
  rootDir: string,
  config: PrettierConfig | null,
  names: readonly string[],
): string {
  const ast = parse(babel, text, file, rootDir)
  const splices: { start: number; end: number; raw: string }[] = []
  babel.traverse(ast, (node, ancestors) => {
    const member = memberCallee(node)
    if (
      member === undefined ||
      !names.includes(member.property.name ?? '') ||
      member.callee.loc == null ||
      member.callee.computed === true
    ) {
      return
    }
    let template: BabelNode | undefined
    for (const arg of node.arguments ?? []) {
      if (arg.type === 'TemplateLiteral') template = arg
    }
    const quasi = template?.quasis?.[0]
    if (quasi === undefined) return
    const parent = ancestors.at(-1)?.node
    const startColumn =
      parent !== undefined && babel.isAwaitExpression(parent) && parent.loc != null
        ? parent.loc.start.column
        : member.callee.loc.start.column
    const useSpaces = config?.useTabs !== true
    const tabWidth = typeof config?.tabWidth === 'number' ? config.tabWidth : 1
    const raw = indent(
      quasi.value.raw,
      Math.ceil(useSpaces ? startColumn / tabWidth : startColumn / 2),
      useSpaces ? ' '.repeat(tabWidth) : '\t',
    )
    if (typeof quasi.start === 'number' && typeof quasi.end === 'number') {
      splices.push({ start: quasi.start, end: quasi.end, raw })
    }
  })
  return splices
    .sort((a, b) => b.start - a.start)
    .reduce((sofar, { start, end, raw }) => sofar.slice(0, start) + raw + sofar.slice(end), text)
}

/** Jest's Prettier 3 path (`worker.ts`), through `format` twice. */
async function formatted(
  prettier: Prettier3,
  babel: Babel,
  file: string,
  text: string,
  names: readonly string[],
  rootDir: string,
): Promise<string> {
  const config = await prettier.resolveConfig(file, { editorconfig: true })
  const parser =
    typeof config?.parser === 'string'
      ? config.parser
      : (await prettier.getFileInfo(file)).inferredParser
  if (!parser) throw new Error(`Could not infer Prettier parser for file ${file}`)
  const options = { ...config, filepath: file, parser }
  const once = await prettier.format(text, options)
  return await prettier.format(reindented(babel, once, file, rootDir, config, names), options)
}

/** The major version of a `x.y.z` string. */
function major(version: string): number {
  return Number.parseInt(version, 10)
}

/** `saveInlineSnapshots`: every file's edits, one file at a time. */
async function writeInlineSnapshots(
  edits: readonly InlineSnapshotEdit[],
  options: InlineSnapshotWriteOptions,
): Promise<readonly string[]> {
  const warnings: string[] = []
  const prettier = options.prettierPath === null ? undefined : loadPrettier(options.prettierPath)
  const byFile = new Map<string, InlineSnapshotEdit[]>()
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit])
  for (const [file, fileEdits] of byFile) {
    const babel = babelFor(options.rootDir)
    const source = readFileSync(file, 'utf8')
    const { text, names } = withSnapshots(babel, fileEdits, file, source, options.rootDir)
    let next = text
    if (prettier !== undefined && major(prettier.version) >= 3) {
      next = await formatted(prettier, babel, file, text, names, options.rootDir)
    } else if (prettier !== undefined) {
      warnings.push(
        `Inline snapshots in ${file} were written without formatting: Provino formats them with Prettier 3 only, and the project's Prettier is ${prettier.version}.`,
      )
    }
    if (next !== source) writeFileSync(file, next)
  }
  return warnings
}

/**
 * The Jest dialect's inline snapshot writer (`snapshot.inline.writer`).
 * @public
 */
export const jestInlineSnapshotWriter: InlineSnapshotWriterFactory = (): InlineSnapshotWriter =>
  writeInlineSnapshots
