// The editing half of the hoister: move the statements `analyse` chose, and, when something moves
// to the top of a file that has static imports, turn those imports into `await import()` calls
// placed after the hoisted block (B13b P9). Moves go through magic-string's `move`, so every moved
// statement and rewritten reference keeps its original line and column in the map.
import type { HoistPolicy, SourceMapV3 } from '@provino/types'
import MagicString from 'magic-string'
import { toSourceMapV3 } from '../internal/maps.ts'
import type { Analysis, ImportRef, Unit } from './analyse.ts'
import {
  bodyOf,
  exportName,
  type ImportDeclaration,
  isDirective,
  isImportDeclaration,
  isTypeOnly,
  type Node,
  type Program,
} from './ast.ts'

export interface Applied {
  readonly code: string
  readonly map: SourceMapV3
  readonly rewroteImports: boolean
}

const IMPORT_PREFIX = '__provino_import_'
const REF_PREFIX = '__provino_ref_'
/** The module-runner form's helper for `export * from` (the loader's wrapper passes it in). */
const EXPORT_ALL = '__vite_ssr_exportAll__'

/** The static imports whose uses move to `__provino_import_N__`: all but the runner's own. */
export function rewritableImports(
  program: Program,
  policy: HoistPolicy,
): ReadonlySet<ImportDeclaration> {
  const found = new Set<ImportDeclaration>()
  for (const node of program.body) {
    if (
      isImportDeclaration(node) &&
      !isTypeOnly(node) &&
      !policy.runnerModules.includes(node.source.value)
    ) {
      found.add(node)
    }
  }
  return found
}

/** The end of a statement's own line, so a moved statement takes its newline with it. */
function tailEnd(code: string, end: number): number {
  let at = end
  if (code[at] === '\r') at++
  if (code[at] === '\n') at++
  return at === end && code[end] === ';' ? end + 1 : at
}

function importExpression(code: string, node: ImportDeclaration | Node): string {
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
  return `await import(${JSON.stringify(source.value)}${withClause})`
}

function bindingFor(ref: ImportRef, id: string): string {
  const spec = ref.spec
  if (spec.type === 'ImportNamespaceSpecifier') return id
  if (spec.type === 'ImportDefaultSpecifier') return `${id}.default`
  const name = exportName(spec.imported)
  return spec.imported.type === 'Literal' ? `${id}[${JSON.stringify(name)}]` : `${id}.${name}`
}

export function applyHoist(
  code: string,
  filename: string,
  policy: HoistPolicy,
  program: Program,
  analysis: Analysis,
): Applied | null {
  if (analysis.units.length === 0 && analysis.argEdits.length === 0) return null
  const s = new MagicString(code)

  for (const edit of analysis.argEdits) s.overwrite(edit.start, edit.end, edit.text)

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

  function moveBefore(move: Move, index: number): void {
    // Already adjacent to the anchor: nothing to do.
    if (index >= move.start && index <= move.end) return
    s.move(move.start, move.end, index)
  }

  /**
   * Puts the queued statements, in order, ahead of the first statement that stays. An index names
   * the original position of a chunk that must not itself move, so the anchor is a statement that
   * stays (or, when everything in the body moves, the last one, with moves on both sides of it).
   */
  function arrange(container: Node, list: readonly Move[]): void {
    const body = bodyOf(container).filter((node) => !isDirective(node))
    const queued = new Set(list.map((move) => move.node))
    const at = new Map(body.map((node, i) => [node, i]))
    // The longest suffix of the queue that is already in place: consecutive in the body, in
    // order, with nothing but queued statements ahead of it. It stays, and is the anchor.
    let first = list.length - 1
    const fits = (i: number): boolean => {
      const head = list[i]
      if (head === undefined) return false
      const index = at.get(head.node) ?? -1
      if (index < 0 || !body.slice(0, index).every((node) => queued.has(node))) return false
      for (let j = i + 1; j < list.length; j++) {
        if (at.get(list[j]?.node as Node) !== index + (j - i)) return false
      }
      return true
    }
    while (first >= 0 && fits(first - 1)) first--
    if (first === list.length - 1 && !fits(first)) first = list.length
    if (first < list.length) {
      const anchor = list[first]
      if (anchor === undefined) return
      for (const move of list.slice(0, first)) moveBefore(move, anchor.start)
      return
    }
    // Nothing is in place: everything goes ahead of the first statement that stays.
    const staying = body.find((node) => !queued.has(node))
    if (staying === undefined) return
    for (const move of list) moveBefore(move, staying.start)
  }

  function placeUnit(unit: Unit): void {
    const { stmt } = unit
    if (code[stmt.end - 1] !== ';') s.appendLeft(stmt.end, ';')
    if (unit.guard !== null) {
      if (stmt.type === 'VariableDeclaration') {
        // `var` keeps the declared names visible outside the `if` block.
        s.update(stmt.start, stmt.start + stmt.kind.length, 'var')
      }
      s.prependRight(stmt.start, `if (${unit.guard}) { `)
      s.appendLeft(stmt.end, ' }')
    }
    const end = tailEnd(code, stmt.end)
    if (code[end - 1] !== '\n') s.appendLeft(end, '\n')
    queue(unit.container, stmt, end)
  }

  const programUnits = groups.get(program)
  // `static` leaves every `export … from` as written, as Vitest's `hoistMocks.ts` does.
  const reexports =
    policy.reExports === 'static'
      ? []
      : program.body.filter(
          (node) =>
            (node.type === 'ExportNamedDeclaration' && node.source !== null && !isTypeOnly(node)) ||
            (node.type === 'ExportAllDeclaration' && !isTypeOnly(node)),
        )
  const imports = rewritableImports(program, policy)
  const rewrite = programUnits !== undefined && (imports.size > 0 || reexports.length > 0)

  // Runner imports stay static and first, ahead of everything that moves.
  if (programUnits !== undefined) {
    for (const node of program.body) {
      if (isImportDeclaration(node) && policy.runnerModules.includes(node.source.value)) {
        const end = tailEnd(code, node.end)
        if (code[end - 1] !== '\n') s.appendLeft(end, '\n')
        queue(program, node, end)
      }
    }
  }

  // Constants first, then calls, each in source order: the order Jest gives.
  for (const [container, units] of groups) {
    const ordered = units.toSorted(
      (a, b) =>
        Number(a.kind === 'call') - Number(b.kind === 'call') || a.stmt.start - b.stmt.start,
    )
    void container
    for (const unit of ordered) placeUnit(unit)
  }

  let rewroteImports = false
  if (rewrite) {
    const ids = new Map<Node, string>()
    let next = 0
    for (const node of program.body) {
      if ((isImportDeclaration(node) && imports.has(node)) || reexports.includes(node)) {
        ids.set(node, `${IMPORT_PREFIX}${next++}__`)
      }
    }

    // `export { x }` of an imported binding needs a local of its own to export.
    const exportRefs = new Map<ImportDeclaration, string[]>()
    let refCount = 0
    for (const ref of analysis.refs) {
      const id = ids.get(ref.decl)
      if (id === undefined) continue
      const binding = bindingFor(ref, id)
      if (ref.exportSpecifier === null) {
        if (ref.shorthand) s.appendLeft(ref.end, `: ${binding}`)
        else s.update(ref.start, ref.end, binding)
        continue
      }
      const name = `${REF_PREFIX}${refCount++}__`
      const consts = exportRefs.get(ref.decl)
      const line = `const ${name} = ${binding};`
      if (consts === undefined) exportRefs.set(ref.decl, [line])
      else consts.push(line)
      const specifier = ref.exportSpecifier
      const shorthand =
        specifier.type === 'ExportSpecifier' && specifier.exported.start === specifier.local.start
      s.update(
        ref.start,
        ref.end,
        shorthand ? `${name} as ${(ref.node as { name: string }).name}` : name,
      )
    }

    for (const node of program.body) {
      const id = ids.get(node)
      if (id === undefined) continue
      let text = `const ${id} = ${importExpression(code, node)};`
      if (isImportDeclaration(node)) {
        text += (exportRefs.get(node) ?? []).join('')
      } else if (node.type === 'ExportNamedDeclaration') {
        const names = node.specifiers.map((specifier, i) => {
          const local = exportName(specifier.local)
          const binding =
            specifier.local.type === 'Literal'
              ? `${id}[${JSON.stringify(local)}]`
              : `${id}.${local}`
          const ref = `${REF_PREFIX}${refCount + i}__`
          return {
            ref,
            binding,
            exported: code.slice(specifier.exported.start, specifier.exported.end),
          }
        })
        refCount += names.length
        text += names.map((n) => `const ${n.ref} = ${n.binding};`).join('')
        if (names.length > 0) {
          text += `export { ${names.map((n) => `${n.ref} as ${n.exported}`).join(', ')} };`
        }
      } else if (node.type === 'ExportAllDeclaration' && node.exported !== null) {
        text += `export { ${id} as ${code.slice(node.exported.start, node.exported.end)} };`
      } else if (node.type === 'ExportAllDeclaration') {
        // `export *` has no dynamic form in ESM. The module-runner form (D10) has one, and its
        // wrapper supplies the helper, so the output is only valid as input to `toModuleRunner`.
        text += `${EXPORT_ALL}(${id});`
      }
      const end = tailEnd(code, node.end)
      s.update(node.start, node.end, end === node.end ? `${text}\n` : text)
      queue(program, node, end)
      rewroteImports = true
    }
  }

  for (const [container, list] of moves) arrange(container, list)

  return {
    code: s.toString(),
    map: toSourceMapV3(
      s.generateMap({ source: filename, hires: 'boundary', includeContent: false }),
    ),
    rewroteImports,
  }
}
