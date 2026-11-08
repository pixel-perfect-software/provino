// The editing half of the hoister: move the statements `analyse` chose, and, when something moves
// to the top of a file that has static imports, turn those imports into
// `await __provino_import__()` calls placed after the hoisted block (D36, in D38's sync-capable
// form: the loader supplies the function and strips the `await` when it evaluates synchronously).
// Moves go through magic-string's `move`, so every moved statement and rewritten reference keeps
// its original line and column in the map.
import type { HoistPolicy, SourceMapV3 } from '@provino/types'
import MagicString from 'magic-string'
import { toSourceMapV3 } from '../internal/maps.ts'
import type { Analysis, ImportRef, Unit } from './analyse.ts'
import {
  bodyOf,
  type ExportNamedDeclaration,
  exportName,
  type ImportDeclaration,
  isDirective,
  isImportDeclaration,
  isTypeOnly,
  type ModuleExportName,
  type Node,
  type Program,
} from './ast.ts'

export interface Applied {
  readonly code: string
  readonly map: SourceMapV3
  readonly rewroteImports: boolean
  readonly lateDeps: readonly string[]
}

const IMPORT_PREFIX = '__provino_import_'
/**
 * The loader's late import (D38): `await __provino_import__('./a')` loads `./a` through the mock
 * decision when the call runs. The loader's wrapper passes it in, and on its sync path strips the
 * `await`.
 * @public
 */
export const LATE_IMPORT = '__provino_import__'
/** The module-runner form's helper for `export * from` (the loader's wrapper passes it in). */
const EXPORT_ALL = '__vite_ssr_exportAll__'
/** The module-runner form's exports object (the loader's wrapper passes it in). */
const EXPORTS = '__vite_ssr_exports__'
/** What a line can start with and still continue the line before it, with no `;` between. */
const CONTINUES = new Set(['[', '(', '`', '+', '-', '/', '<'])
const LINE_BREAK = /[\n\r\p{Zl}\p{Zp}]/u

/** The offset of the next character that is not whitespace or inside a comment. */
function skipTrivia(code: string, from: number): number {
  let at = from
  while (at < code.length) {
    const char = code[at] ?? ''
    if (char === '/' && code[at + 1] === '/') {
      at += 2
      while (at < code.length && !LINE_BREAK.test(code[at] ?? '')) at++
    } else if (char === '/' && code[at + 1] === '*') {
      const close = code.indexOf('*/', at + 2)
      if (close === -1) return code.length
      at = close + 2
    } else if (/\s/.test(char)) {
      at++
    } else {
      return at
    }
  }
  return at
}

/** The end of a statement's own line, so a moved statement takes its newline with it. */
function tailEnd(code: string, end: number): number {
  let at = end
  if (code[at] === '\r') at++
  if (code[at] === '\n') at++
  return at
}

function importExpression(code: string, node: Node): string {
  const source = 'source' in node && node.source !== null ? node.source : null
  if (source === null || !('value' in source)) throw new Error('an import without a source')
  const attributes = ('attributes' in node ? node.attributes : []).flatMap((attribute) =>
    attribute.type === 'ImportAttribute'
      ? [
          `${code.slice(attribute.key.start, attribute.key.end)}: ${code.slice(attribute.value.start, attribute.value.end)}`,
        ]
      : [],
  )
  const withClause = attributes.length === 0 ? '' : `, { with: { ${attributes.join(', ')} } }`
  return `await ${LATE_IMPORT}(${JSON.stringify(source.value)}${withClause})`
}

function sourceOf(node: Node): string {
  const source = 'source' in node && node.source !== null ? node.source : null
  if (source === null || !('value' in source) || typeof source.value !== 'string') {
    throw new Error('an import without a source')
  }
  return source.value
}

/** A read of one export of the namespace `id`. */
function memberOf(id: string, name: ModuleExportName): string {
  const text = exportName(name)
  return name.type === 'Literal' ? `${id}[${JSON.stringify(text)}]` : `${id}.${text}`
}

function bindingFor(ref: ImportRef, id: string): string {
  const spec = ref.spec
  if (spec.type === 'ImportNamespaceSpecifier') return id
  if (spec.type === 'ImportDefaultSpecifier') return `${id}.default`
  return memberOf(id, spec.imported)
}

/**
 * The live form of an export of an import. It goes straight before the `await import`, so a read
 * during a cycle meets the namespace `const` in its dead zone rather than a frozen `undefined`.
 */
function liveExport(exported: string, binding: string): string {
  return `Object.defineProperty(${EXPORTS}, ${JSON.stringify(exported)}, { enumerable: true, configurable: true, get: () => ${binding} });`
}

export function applyHoist(
  code: string,
  filename: string,
  policy: HoistPolicy,
  program: Program,
  analysis: Analysis,
): Applied | null {
  const programUnits = analysis.units.some((unit) => unit.container === program)
  // `static` leaves every `export … from` as written, as Vitest's `hoistMocks.ts` does.
  const reexports =
    policy.reExports === 'static'
      ? []
      : program.body.filter(
          (node) =>
            (node.type === 'ExportNamedDeclaration' && node.source !== null && !isTypeOnly(node)) ||
            (node.type === 'ExportAllDeclaration' && !isTypeOnly(node)),
        )
  const imports = analysis.rewritable
  const rewrite =
    (programUnits || analysis.rewritesImports) && (imports.size > 0 || reexports.length > 0)
  if (analysis.units.length === 0 && analysis.argEdits.length === 0 && !rewrite) return null
  const s = new MagicString(code)

  const groups = new Map<Node, Unit[]>()
  for (const unit of analysis.units) {
    const group = groups.get(unit.container)
    if (group === undefined) groups.set(unit.container, [unit])
    else group.push(unit)
  }
  interface Move {
    readonly node: Node
    readonly start: number
    readonly end: number
  }
  const moves = new Map<Node, Move[]>()
  function queue(container: Node, node: Node, end: number): void {
    const move = { node, start: node.start, end }
    const list = moves.get(container)
    if (list === undefined) moves.set(container, [move])
    else list.push(move)
  }

  /**
   * Puts the queued statements, in order, ahead of the first statement that stays. `move(a, b, i)`
   * inserts before the chunk that starts at `i`, wherever that chunk is by now, and refuses an `i`
   * within `[a, b]`. So statements next to each other in both orders become one block, which leaves
   * no index inside a moved range; and walking from the last block back, each goes before the one
   * placed after it. A block that already ends at its target is there. With no stayer, the last
   * block stays and the others go ahead of it.
   */
  function arrange(container: Node, list: readonly Move[]): void {
    const blocks: { start: number; end: number }[] = []
    for (const { start, end } of list) {
      const previous = blocks.at(-1)
      if (previous?.end === start) previous.end = end
      else blocks.push({ start, end })
    }
    const queued = new Set(list.map((move) => move.node))
    const staying = bodyOf(container).find((node) => !isDirective(node) && !queued.has(node))
    const last = blocks.at(-1)
    if (last === undefined) return
    let target = staying?.start ?? last.start
    for (const block of blocks.toReversed()) {
      if (block.end !== target && !(staying === undefined && block === last)) {
        // The statement before this one now meets whatever came after it.
        if (CONTINUES.has(code[skipTrivia(code, block.end)] ?? '')) {
          s.prependRight(block.end, ';')
        }
        // And this one now meets whatever it lands after.
        if (CONTINUES.has(code[block.start] ?? '')) s.prependRight(block.start, ';')
        s.move(block.start, block.end, target)
      }
      target = block.start
    }
  }

  function placeUnit(unit: Unit): void {
    const { stmt } = unit
    const own = stmt.end
    if (code[own - 1] !== ';') s.appendLeft(own, ';')
    if (unit.guard !== null) {
      if (stmt.type === 'VariableDeclaration') {
        // `var` keeps the declared names visible outside the `if` block.
        s.update(stmt.start, stmt.start + stmt.kind.length, 'var')
      }
      s.prependRight(stmt.start, `if (${unit.guard}) { `)
      s.appendLeft(own, ' }')
    }
    const end = tailEnd(code, own)
    if (code[end - 1] !== '\n') s.appendLeft(end, '\n')
    queue(unit.container, stmt, end)
  }

  // Runner imports stay static and first, ahead of everything that moves.
  if (programUnits || rewrite) {
    for (const node of program.body) {
      if (isImportDeclaration(node) && policy.runnerModules.includes(node.source.value)) {
        const end = tailEnd(code, node.end)
        if (code[end - 1] !== '\n') s.appendLeft(end, '\n')
        queue(program, node, end)
      }
    }
  }

  // Constants first, then calls, each in source order: the order Jest gives.
  for (const units of groups.values()) {
    const ordered = units.toSorted(
      (a, b) =>
        Number(a.kind === 'call') - Number(b.kind === 'call') || a.stmt.start - b.stmt.start,
    )
    for (const unit of ordered) placeUnit(unit)
  }

  const lateDeps: string[] = []
  if (rewrite) {
    const ids = new Map<Node, string>()
    let next = 0
    for (const node of program.body) {
      if ((isImportDeclaration(node) && imports.has(node)) || reexports.includes(node)) {
        ids.set(node, `${IMPORT_PREFIX}${next++}__`)
        lateDeps.push(sourceOf(node))
      }
    }

    // `export { x }` of an imported binding becomes a getter by that binding's `await import`, and
    // leaves its export list.
    const getters = new Map<ImportDeclaration, string[]>()
    const unexported = new Map<ExportNamedDeclaration, Set<Node>>()
    for (const ref of analysis.refs) {
      const id = ids.get(ref.decl)
      if (id === undefined) continue
      const binding = bindingFor(ref, id)
      if (ref.exported !== null) {
        const { specifier, declaration } = ref.exported
        const getter = liveExport(exportName(specifier.exported), binding)
        const list = getters.get(ref.decl)
        if (list === undefined) getters.set(ref.decl, [getter])
        else list.push(getter)
        const gone = unexported.get(declaration)
        if (gone === undefined) unexported.set(declaration, new Set([specifier]))
        else gone.add(specifier)
      } else if (ref.shorthand) {
        s.appendLeft(ref.end, `: ${binding}`)
      } else if (
        ref.called &&
        policy.rewrittenCalls === 'detached' &&
        ref.spec.type !== 'ImportNamespaceSpecifier'
      ) {
        s.update(ref.start, ref.end, `${ref.opensStatement ? ';' : ''}(0, ${binding})`)
      } else {
        s.update(ref.start, ref.end, binding)
      }
    }

    for (const [declaration, gone] of unexported) {
      const kept = declaration.specifiers
        .filter((specifier) => !gone.has(specifier))
        .map((specifier) => code.slice(specifier.start, specifier.end))
      s.update(
        declaration.start,
        declaration.end,
        kept.length === 0 ? 'export {};' : `export { ${kept.join(', ')} };`,
      )
    }

    for (const node of program.body) {
      const id = ids.get(node)
      if (id === undefined) continue
      const live: readonly string[] = isImportDeclaration(node)
        ? (getters.get(node) ?? [])
        : node.type === 'ExportNamedDeclaration'
          ? node.specifiers.map((specifier) =>
              liveExport(exportName(specifier.exported), memberOf(id, specifier.local)),
            )
          : []
      let text = `${live.join('')}const ${id} = ${importExpression(code, node)};`
      if (node.type === 'ExportAllDeclaration') {
        // `export *` has no dynamic form in ESM. The module-runner form (D10) has one, and its
        // wrapper supplies the helper, so the output is only valid as input to `toModuleRunner`.
        text +=
          node.exported === null
            ? `${EXPORT_ALL}(${id});`
            : `export { ${id} as ${code.slice(node.exported.start, node.exported.end)} };`
      }
      const end = tailEnd(code, node.end)
      s.update(node.start, node.end, end === node.end ? `${text}\n` : text)
      queue(program, node, end)
    }
  }

  // After the rewrite, so an unwrapped `import(x)` carries the rewritten `x`.
  for (const edit of analysis.argEdits) {
    s.overwrite(edit.start, edit.end, s.slice(edit.sourceStart, edit.sourceEnd))
  }

  for (const [container, list] of moves) arrange(container, list)

  return {
    code: s.toString(),
    map: toSourceMapV3(
      s.generateMap({ source: filename, hires: 'boundary', includeContent: false }),
    ),
    rewroteImports: rewrite,
    lateDeps,
  }
}
