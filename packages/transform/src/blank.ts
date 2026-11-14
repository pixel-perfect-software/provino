// D116 (B23b Phase 4, T8.10): TypeScript stripped in place. Oxc parses the file, and every piece of
// type-only syntax is overwritten with spaces, line breaks kept, so each token that stays keeps its
// offset, line and column: no code generation and no source map. Istanbul then instruments code
// whose positions are the TypeScript file's, as Jest's babel provider does (its recorder strips
// with Node's `module.stripTypeScriptTypes`, mode `strip`).
//
// The rules are ts-blank-space's (bloomberg/ts-blank-space, Apache-2.0, `src/index.ts` and
// `src/blank-string.ts`), rebuilt over Oxc's AST rather than copied:
// - a removed statement or class member that would let the next one continue the one before it
//   (`x = 1` / `interface I {}` / `(y)`) gets a `;` in its blanked text (ts-blank-space's
//   `blankButStartWithSemi`); here the `;` goes only where that hazard exists, so it ends the
//   statement before and adds no empty statement;
// - an arrow function whose return type spans lines would put a line break before `=>`; the `)` of
//   its parameters moves to the end of the return type (`blankButEndWithCloseParen`);
// - what the language cannot read as JavaScript with the types gone falls back: ts-blank-space
//   lists enums, namespaces with values, parameter properties, `import x = require()` and
//   `export =` as unsupported, and so do we. `blankTypeScript` returns `{ ok: false, reason }` and
//   the pipeline uses Oxc's transform and the remap instead.
//
// Import elision matches Oxc's TypeScript transform (what the pipeline ran before D116): without
// `onlyRemoveTypeImports`, an import specifier no value position refers to goes (scope-aware, through
// the module-runner's own reference walk), and the declaration goes when all of its specifiers do;
// `export { T }` of a type-only name goes. Every rule is checked file by file against Oxc's output
// (`bench/blank-corpus.test.ts`).
import {
  type ArrowFunctionExpression,
  type Function as FunctionNode,
  type Node,
  type ParseResult,
  type ParserOptions,
  type Program,
  parseSync,
  rawTransferSupported,
} from 'oxc-parser'
import { CONTINUES_LINE, skipTrivia } from './internal/trivia.ts'
import { type ImportBinding, isImportReference, walkProgram } from './runner/analyse.ts'

/**
 * How the file's tsconfig sets the parts of Oxc's transform that are not erasure.
 * @internal
 */
export interface BlankOptions {
  /** `verbatimModuleSyntax`: only `type` imports go, as Oxc's `onlyRemoveTypeImports`. */
  readonly onlyRemoveTypeImports: boolean
  /** `experimentalDecorators`: Oxc rewrites legacy decorators, so a decorator is not erasable. */
  readonly legacyDecorators: boolean
  /** `useDefineForClassFields`: when false, Oxc rewrites class fields, so a field is not erasable. */
  readonly defineClassFields: boolean
  readonly sourceType: 'module' | 'commonjs'
}

/**
 * The blanked code, or why the file needs Oxc's transform.
 * @internal
 */
export type BlankResult = (
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: string }
) & {
  /**
   * The parse of the source, with the options `moduleFacts` parses with, so the pipeline reads the
   * record's import facts from it instead of parsing the file again.
   */
  readonly parsed: ParseResult
}

type Options = ParserOptions & { experimentalRawTransfer?: boolean }

const RAW_TRANSFER = rawTransferSupported()

const PARSE: Options = {
  lang: 'ts',
  ...(RAW_TRANSFER ? { experimentalRawTransfer: true } : {}),
}

/** Thrown inside the walk when the file holds syntax that has runtime meaning. */
class NotErasable extends Error {}

function fail(reason: string): never {
  throw new NotErasable(reason)
}

const MODIFIERS: ReadonlySet<string> = new Set([
  'public',
  'private',
  'protected',
  'readonly',
  'override',
  'declare',
  'abstract',
])

/** A class member can also be continued by a generator method's `*`. */
const CONTINUES_MEMBER: ReadonlySet<string> = new Set([...CONTINUES_LINE, '*'])

const WORD = /[A-Za-z_$][\w$]*/y

function isLineBreak(char: number): boolean {
  return char === 10 || char === 13 || char === 0x2028 || char === 0x2029
}

function hasLineBreak(source: string, start: number, end: number): boolean {
  for (let at = start; at < end; at++) if (isLineBreak(source.charCodeAt(at))) return true
  return false
}

type Span = { readonly start: number; readonly end: number }

/** A list whose items the `;` rule looks between: statements, or a class body's members. */
interface ItemList {
  readonly items: readonly Node[]
  readonly members: boolean
}

/**
 * Strips the TypeScript in `source` in place (D116), or says why it can't.
 * @internal
 */
export function blankTypeScript(
  filename: string,
  source: string,
  options: BlankOptions,
): BlankResult {
  const parsed = parseSync(filename, source, { ...PARSE, sourceType: options.sourceType })
  // The Oxc transform reports the file's errors as it does today.
  if (parsed.errors.length > 0) return { ok: false, reason: 'the file has parse errors', parsed }
  try {
    return { ok: true, code: blankProgram(source, parsed.program, options), parsed }
  } catch (error) {
    if (error instanceof NotErasable) return { ok: false, reason: error.message, parsed }
    throw error
  }
}

function blankProgram(source: string, program: Program, options: BlankOptions): string {
  /** Blanked ranges, `[start, end)`, in the order found. */
  const ranges: Span[] = []
  /** A character written over a blanked one: a moved `)` or a `;`. */
  const inserts = new Map<number, string>()
  const lists: ItemList[] = []
  /** Statements and members blanked whole. */
  const removed = new Set<Node>()
  const imports: Extract<Node, { type: 'ImportDeclaration' }>[] = []
  const exports: Extract<Node, { type: 'ExportNamedDeclaration' }>[] = []
  const defaultExports: Extract<Node, { type: 'ExportDefaultDeclaration' }>[] = []

  function blank(start: number, end: number): void {
    if (end > start) ranges.push({ start, end })
  }

  function remove(node: Node): void {
    removed.add(node)
    blank(node.start, node.end)
  }

  /** Blanks the modifier keywords in `[from, to)` (`private`, `readonly`, …), keeping `static`. */
  function blankModifiers(from: number, to: number): void {
    let at = skipTrivia(source, from)
    while (at < to) {
      WORD.lastIndex = at
      const word = WORD.exec(source)?.[0]
      if (word === undefined) return
      if (MODIFIERS.has(word)) blank(at, at + word.length)
      at = skipTrivia(source, at + word.length)
    }
  }

  /** Blanks the `?` or `!` after a key (past a computed key's `]`). */
  function blankMarker(from: number, char: '?' | '!'): void {
    let at = skipTrivia(source, from)
    if (source[at] === ']') at = skipTrivia(source, at + 1)
    if (source[at] !== char) fail(`no \`${char}\` where the AST has one`)
    blank(at, at + 1)
  }

  /** Blanks the last `?` or `!` in `[start, limit)`: a binding's marker before its type. */
  function blankLastMarker(start: number, limit: number, char: '?' | '!'): void {
    const at = source.lastIndexOf(char, limit - 1)
    if (at < start) fail(`no \`${char}\` where the AST has one`)
    blank(at, at + 1)
  }

  /**
   * The offset after `end` and any `)` that closes it: the parser drops parentheses, so `(b) as T`
   * is an `as` whose expression `b` ends before the `)`.
   */
  function afterParens(end: number): number {
    let at = end
    for (let next = skipTrivia(source, at); source[next] === ')'; next = skipTrivia(source, at)) {
      at = next + 1
    }
    return at
  }

  function decoratorsEnd(node: { readonly decorators?: readonly Node[] }, start: number): number {
    const decorators = node.decorators ?? []
    return decorators.length === 0 ? start : (decorators[decorators.length - 1]?.end ?? start)
  }

  function visitDecorators(node: { readonly decorators?: readonly Node[] }): void {
    for (const decorator of node.decorators ?? []) visit(decorator)
  }

  /** Whether a statement is type-only (blanked whole). Throws for syntax with runtime meaning. */
  function typeOnly(node: Node): boolean {
    switch (node.type) {
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSDeclareFunction':
      case 'TSNamespaceExportDeclaration':
        return true
      case 'TSModuleDeclaration':
        if (node.declare || node.kind === 'global' || node.id.type === 'Literal') return true
        if (node.body !== null && instantiated(node.body.body)) fail('a namespace with values')
        return true
      case 'TSEnumDeclaration':
        if (node.declare) return true
        return fail('an enum')
      case 'TSImportEqualsDeclaration':
        if (node.importKind === 'type') return true
        return fail('`import x =`')
      case 'TSExportAssignment':
        return fail('`export =`')
      case 'VariableDeclaration':
      case 'ClassDeclaration':
        return node.declare === true
      case 'FunctionDeclaration':
        return node.declare === true || node.body === null
      case 'ImportDeclaration':
        return node.importKind === 'type'
      case 'ExportAllDeclaration':
        return node.exportKind === 'type'
      case 'ExportNamedDeclaration':
        return (
          node.exportKind === 'type' || (node.declaration !== null && typeOnly(node.declaration))
        )
      case 'ExportDefaultDeclaration':
        return node.declaration.type === 'TSInterfaceDeclaration' || typeOnlyDefault(node)
      default:
        return false
    }
  }

  function typeOnlyDefault(node: Extract<Node, { type: 'ExportDefaultDeclaration' }>): boolean {
    const declaration = node.declaration
    return (
      (declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction') &&
      declaration.body === null
    )
  }

  /** Whether a namespace body holds a value (so TypeScript emits an object for it). */
  function instantiated(body: readonly Node[]): boolean {
    for (const statement of body) {
      try {
        if (!typeOnly(statement)) return true
      } catch (error) {
        if (error instanceof NotErasable) return true
        throw error
      }
    }
    return false
  }

  function memberTypeOnly(node: Node): boolean {
    switch (node.type) {
      case 'TSAbstractMethodDefinition':
      case 'TSAbstractPropertyDefinition':
      case 'TSAbstractAccessorProperty':
      case 'TSIndexSignature':
        return true
      case 'MethodDefinition':
        return node.value.type === 'TSEmptyBodyFunctionExpression'
      case 'PropertyDefinition':
        return node.declare === true
      default:
        return false
    }
  }

  function visitList(items: readonly Node[], members: boolean): void {
    lists.push({ items, members })
    for (const item of items) {
      if (members ? memberTypeOnly(item) : typeOnly(item)) remove(item)
      else if (members) visitMember(item)
      else visitStatement(item)
    }
  }

  function visitStatement(node: Node): void {
    switch (node.type) {
      case 'ImportDeclaration':
        imports.push(node)
        return
      case 'ExportNamedDeclaration':
        if (node.declaration !== null) visit(node.declaration)
        else exports.push(node)
        return
      case 'ExportDefaultDeclaration':
        if (node.declaration.type === 'Identifier') defaultExports.push(node)
        else visit(node.declaration)
        return
      case 'ExportAllDeclaration':
        return
      default:
        visit(node)
    }
  }

  function visitMember(node: Node): void {
    switch (node.type) {
      case 'MethodDefinition':
        visitDecorators(node)
        blankModifiers(decoratorsEnd(node, node.start), node.key.start)
        if (node.computed) visit(node.key)
        if (node.optional === true) blankMarker(node.key.end, '?')
        visit(node.value)
        return
      case 'PropertyDefinition':
      case 'AccessorProperty':
        if (!options.defineClassFields) fail('a class field under `useDefineForClassFields: false`')
        visitDecorators(node)
        blankModifiers(decoratorsEnd(node, node.start), node.key.start)
        if (node.computed) visit(node.key)
        if (node.optional === true) blankMarker(node.key.end, '?')
        if (node.definite === true) blankMarker(node.key.end, '!')
        if (node.typeAnnotation !== null && node.typeAnnotation !== undefined) {
          blank(node.typeAnnotation.start, node.typeAnnotation.end)
        }
        if (node.value !== null) visit(node.value)
        return
      case 'StaticBlock':
        visitList(node.body, false)
        return
      default:
        visit(node)
    }
  }

  function visitClass(node: Extract<Node, { type: 'ClassDeclaration' | 'ClassExpression' }>): void {
    visitDecorators(node)
    if (node.abstract === true) {
      const end = node.id?.start ?? node.body.start
      let at = skipTrivia(source, decoratorsEnd(node, node.start))
      while (at < end) {
        WORD.lastIndex = at
        const word = WORD.exec(source)?.[0]
        if (word === undefined || word === 'class') break
        if (word === 'abstract') blank(at, at + word.length)
        at = skipTrivia(source, at + word.length)
      }
    }
    if (node.typeParameters !== null && node.typeParameters !== undefined) {
      blank(node.typeParameters.start, node.typeParameters.end)
    }
    if (node.superClass !== null) visit(node.superClass)
    if (node.superTypeArguments !== null && node.superTypeArguments !== undefined) {
      blank(node.superTypeArguments.start, node.superTypeArguments.end)
    }
    const implemented = node.implements ?? []
    const first = implemented[0]
    const last = implemented[implemented.length - 1]
    if (first !== undefined && last !== undefined) {
      const keyword = source.lastIndexOf('implements', first.start)
      if (keyword === -1) fail('no `implements` where the AST has one')
      blank(keyword, last.end)
    }
    visitList(node.body.body, true)
  }

  function visitFunction(node: FunctionNode | ArrowFunctionExpression): void {
    if (node.typeParameters !== null && node.typeParameters !== undefined) {
      const { start, end } = node.typeParameters
      // `async <T,\n>(a) => a` would leave a line break after `async`.
      if (
        node.async &&
        node.type === 'ArrowFunctionExpression' &&
        hasLineBreak(source, start, end)
      ) {
        fail('the type parameters of an async arrow function span lines')
      }
      blank(start, end)
    }
    node.params.forEach((param, index) => {
      if (index === 0 && param.type === 'Identifier' && param.name === 'this') {
        // A `this` parameter goes with the comma after it.
        const next = skipTrivia(source, param.end)
        blank(param.start, source[next] === ',' ? next + 1 : param.end)
        return
      }
      visit(param)
    })
    const returnType = node.returnType
    if (returnType !== null && returnType !== undefined) {
      if (node.type === 'ArrowFunctionExpression') moveArrowParen(returnType)
      blank(returnType.start, returnType.end)
    }
    if (node.body !== null) visit(node.body)
  }

  /**
   * An arrow function's return type with a line break in it would leave one before `=>`, where the
   * language allows none: its `)` moves to the last character of the return type.
   */
  function moveArrowParen(returnType: Span): void {
    let paren = returnType.start - 1
    while (paren >= 0 && /\s/.test(source.charAt(paren))) paren--
    if (source[paren] !== ')') fail('no `)` before an arrow function’s return type')
    if (!hasLineBreak(source, paren, returnType.end)) return
    blank(paren, paren + 1)
    inserts.set(returnType.end - 1, ')')
  }

  function visit(node: Node): void {
    switch (node.type) {
      case 'TSTypeAnnotation':
      case 'TSTypeParameterDeclaration':
      case 'TSTypeParameterInstantiation':
        blank(node.start, node.end)
        return
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
        visit(node.expression)
        blank(afterParens(node.expression.end), node.end)
        return
      case 'TSInstantiationExpression':
        visit(node.expression)
        blank(node.typeArguments.start, node.typeArguments.end)
        return
      case 'TSTypeAssertion': {
        const close = skipTrivia(source, node.typeAnnotation.end)
        if (source[close] !== '>') fail('no `>` after a type assertion’s type')
        // `return <T>\n x` would return nothing.
        if (hasLineBreak(source, node.start, close)) fail('a type assertion spans lines')
        blank(node.start, close + 1)
        visit(node.expression)
        return
      }
      case 'TSParameterProperty':
        fail('a parameter property')
        break
      case 'Decorator':
        if (options.legacyDecorators) fail('a decorator under `experimentalDecorators`')
        visit(node.expression)
        return
      case 'Identifier': {
        const annotation = node.typeAnnotation
        const limit = annotation === null || annotation === undefined ? node.end : annotation.start
        if ((node as { readonly optional?: boolean }).optional === true) {
          blankLastMarker(node.start, limit, '?')
        }
        if (annotation !== null && annotation !== undefined) blank(annotation.start, annotation.end)
        visitDecorators(node)
        return
      }
      case 'VariableDeclarator': {
        const id = node.id
        if (node.definite === true) {
          const annotation = (id as { readonly typeAnnotation?: Span | null }).typeAnnotation
          blankLastMarker(id.start, annotation?.start ?? id.end, '!')
        }
        visit(id)
        if (node.init !== null) visit(node.init)
        return
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(node)
        return
      case 'ClassDeclaration':
      case 'ClassExpression':
        visitClass(node)
        return
      case 'Program':
      case 'BlockStatement':
        visitList(node.body, false)
        return
      case 'SwitchCase':
        if (node.test !== null) visit(node.test)
        visitList(node.consequent, false)
        return
      default:
        if (node.type.startsWith('TS')) fail(`\`${node.type}\` here`)
        visitChildren(node)
    }
  }

  function visitChildren(node: Node): void {
    const fields = node as unknown as Readonly<Record<string, unknown>>
    for (const key in fields) {
      if (key === 'parent') continue
      const value = fields[key]
      if (typeof value !== 'object' || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item)
      } else if (isNode(value)) visit(value)
    }
  }

  visit(program)
  elide(source, program, options, { imports, exports, defaultExports }, blank, remove)
  return render(source, mergeRanges(ranges), inserts, lists, removed)
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
}

interface ModuleStatements {
  readonly imports: readonly Extract<Node, { type: 'ImportDeclaration' }>[]
  readonly exports: readonly Extract<Node, { type: 'ExportNamedDeclaration' }>[]
  readonly defaultExports: readonly Extract<Node, { type: 'ExportDefaultDeclaration' }>[]
}

/** The module-level names a declaration binds, split by whether they exist at run time. */
function moduleNames(program: Program): { types: Set<string>; values: Set<string> } {
  const types = new Set<string>()
  const values = new Set<string>()
  function bind(pattern: Node | null, into: Set<string>): void {
    if (pattern === null) return
    switch (pattern.type) {
      case 'Identifier':
        into.add(pattern.name)
        return
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          bind(property.type === 'Property' ? property.value : property, into)
        }
        return
      case 'ArrayPattern':
        for (const element of pattern.elements) bind(element, into)
        return
      case 'AssignmentPattern':
        bind(pattern.left, into)
        return
      case 'RestElement':
        bind(pattern.argument, into)
        return
      default:
    }
  }
  function declaration(node: Node): void {
    switch (node.type) {
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
      case 'TSImportEqualsDeclaration':
        types.add(node.id.name)
        return
      case 'TSModuleDeclaration':
        if (node.id.type === 'Identifier') types.add(node.id.name)
        return
      case 'TSDeclareFunction':
      case 'FunctionDeclaration':
        if (node.id !== null) {
          const type = node.type === 'TSDeclareFunction' || node.body === null || node.declare
          ;(type === true ? types : values).add(node.id.name)
        }
        return
      case 'ClassDeclaration':
        if (node.id !== null) (node.declare === true ? types : values).add(node.id.name)
        return
      case 'VariableDeclaration':
        for (const declarator of node.declarations) {
          bind(declarator.id, node.declare === true ? types : values)
        }
        return
      case 'ImportDeclaration':
        for (const specifier of node.specifiers) {
          const type =
            node.importKind === 'type' ||
            (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
          ;(type ? types : values).add(specifier.local.name)
        }
        return
      case 'ExportNamedDeclaration':
        if (node.declaration !== null) declaration(node.declaration)
        return
      case 'ExportDefaultDeclaration':
        switch (node.declaration.type) {
          case 'TSInterfaceDeclaration':
          case 'TSDeclareFunction':
          case 'FunctionDeclaration':
          case 'ClassDeclaration':
            declaration(node.declaration)
            return
          default:
            return
        }
      default:
    }
  }
  for (const statement of program.body) declaration(statement)
  return { types, values }
}

/** Blanks the runs of `removed` items of a comma-separated list, with their commas. */
function blankItems(
  items: readonly Span[],
  removed: ReadonlySet<Span>,
  blank: (start: number, end: number) => void,
): void {
  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item === undefined || !removed.has(item)) {
      index++
      continue
    }
    let last = index
    while (last + 1 < items.length && removed.has(items[last + 1] as Span)) last++
    const next = items[last + 1]
    const previous = items[index - 1]
    const lastRemoved = items[last] as Span
    if (next !== undefined) blank(item.start, next.start)
    else if (previous !== undefined) blank(previous.end, lastRemoved.end)
    index = last + 1
  }
}

/**
 * Removes the imports and exports Oxc's TypeScript transform drops (D116's "import elision"):
 * `type` specifiers always; without `onlyRemoveTypeImports`, any import specifier no value refers
 * to, and the declaration with its last specifier; `export { T }` and `export default T` of a
 * type-only name.
 */
function elide(
  source: string,
  program: Program,
  options: BlankOptions,
  statements: ModuleStatements,
  blank: (start: number, end: number) => void,
  remove: (node: Node) => void,
): void {
  const { types, values } = moduleNames(program)
  const typeOnlyName = (name: string): boolean => types.has(name) && !values.has(name)
  const exportedLocals = new Set<string>()

  for (const node of statements.exports) {
    const gone = new Set<Span>()
    for (const specifier of node.specifiers) {
      const local = specifier.local
      if (
        specifier.exportKind === 'type' ||
        (node.source === null && local.type === 'Identifier' && typeOnlyName(local.name))
      ) {
        gone.add(specifier)
      } else if (node.source === null && local.type === 'Identifier') {
        exportedLocals.add(local.name)
      }
    }
    if (gone.size > 0 && gone.size === node.specifiers.length) remove(node)
    else blankItems(node.specifiers, gone, blank)
  }
  for (const node of statements.defaultExports) {
    const declaration = node.declaration
    if (declaration.type === 'Identifier' && typeOnlyName(declaration.name)) remove(node)
  }

  let used: ReadonlySet<string> | null = null
  if (!options.onlyRemoveTypeImports) {
    const bindings = new Map<string, ImportBinding>()
    for (const node of statements.imports) {
      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type') {
          bindings.set(specifier.local.name, { index: 0, imported: null })
        }
      }
    }
    const referenced = new Set<string>(exportedLocals)
    if (bindings.size > 0) {
      for (const reference of walkProgram(program, bindings, { typescript: true }).references) {
        if (isImportReference(reference)) referenced.add(reference.name)
      }
    }
    used = referenced
  }

  for (const node of statements.imports) {
    const specifiers = node.specifiers
    if (specifiers.length === 0) continue
    const gone = new Set<Span>()
    for (const specifier of specifiers) {
      const type = specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'
      if (type || (used !== null && !used.has(specifier.local.name))) gone.add(specifier)
    }
    if (gone.size === 0) continue
    if (gone.size === specifiers.length && used !== null) {
      remove(node)
      continue
    }
    blankImportSpecifiers(source, specifiers, gone, blank)
  }
}

/**
 * Blanks the removed specifiers of an import that keeps at least one, or (with
 * `onlyRemoveTypeImports`) keeps its braces as `import {} from 'x'`, which Oxc prints as
 * `import 'x'`.
 */
function blankImportSpecifiers(
  source: string,
  specifiers: readonly Extract<Node, { type: 'ImportDeclaration' }>['specifiers'][number][],
  gone: ReadonlySet<Span>,
  blank: (start: number, end: number) => void,
): void {
  const first = specifiers[0]
  const head = first !== undefined && first.type !== 'ImportSpecifier' ? first : null
  const named = specifiers.filter((specifier) => specifier !== head)
  const namedKept = named.filter((specifier) => !gone.has(specifier))
  const lastNamed = named[named.length - 1]
  if (head === null) {
    if (namedKept.length === 0 && lastNamed !== undefined && named[0] !== undefined) {
      const end = skipTrivia(source, lastNamed.end)
      blank(named[0].start, source[end] === ',' ? end + 1 : lastNamed.end)
    } else blankItems(named, gone, blank)
    return
  }
  const headGone = gone.has(head)
  // `import D, * as ns`: one of the two goes.
  const second = specifiers[1]
  if (second !== undefined && second.type === 'ImportNamespaceSpecifier') {
    if (headGone && !gone.has(second)) blank(head.start, second.start)
    else if (!headGone && gone.has(second)) blank(head.end, second.end)
    return
  }
  if (lastNamed === undefined) return
  if (namedKept.length === 0) {
    // `import D, { A }` keeps `D`: the braces go too.
    let close = skipTrivia(source, lastNamed.end)
    if (source[close] === ',') close = skipTrivia(source, close + 1)
    if (source[close] !== '}') fail('no `}` after an import’s names')
    blank(head.end, close + 1)
    return
  }
  if (headGone) {
    // `import D, { a }` keeps `a`: `D,` goes, up to the brace.
    let open = skipTrivia(source, head.end)
    if (source[open] === ',') open = skipTrivia(source, open + 1)
    if (source[open] !== '{') fail('no `{` after an import’s default')
    blank(head.start, open)
  }
  blankItems(named, gone, blank)
}

function mergeRanges(ranges: readonly Span[]): Span[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ start: range.start, end: range.end })
  }
  return merged
}

/** The merged range holding `offset`, or `undefined`. */
function rangeAt(ranges: readonly Span[], offset: number): Span | undefined {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const range = ranges[middle] as Span
    if (offset < range.start) high = middle - 1
    else if (offset >= range.end) low = middle + 1
    else return range
  }
  return undefined
}

/** Statements and members that end at a `;` the language may insert. */
function needsTerminator(node: Node): boolean {
  switch (node.type) {
    case 'ExpressionStatement':
    case 'VariableDeclaration':
    case 'ReturnStatement':
    case 'ThrowStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'DebuggerStatement':
    case 'DoWhileStatement':
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'PropertyDefinition':
    case 'AccessorProperty':
      return true
    case 'ExportNamedDeclaration':
      return node.declaration === null || node.declaration.type === 'VariableDeclaration'
    case 'ExportDefaultDeclaration':
      return !['FunctionDeclaration', 'ClassDeclaration', 'TSDeclareFunction'].includes(
        node.declaration.type,
      )
    default:
      return false
  }
}

/**
 * The output: blanked ranges as spaces (line breaks kept), with a `;` where a blanked item would
 * let the next one continue the one before it (ts-blank-space's `blankButStartWithSemi`).
 */
function render(
  source: string,
  ranges: readonly Span[],
  inserts: Map<number, string>,
  lists: readonly ItemList[],
  removed: ReadonlySet<Node>,
): string {
  if (ranges.length === 0) return source

  const blanked = (offset: number): Span | undefined =>
    inserts.has(offset) ? undefined : rangeAt(ranges, offset)

  function firstKept(from: number): number {
    let at = skipTrivia(source, from)
    for (let range = blanked(at); range !== undefined; range = blanked(at)) {
      at = skipTrivia(source, range.end)
    }
    return at
  }

  function lastKept(end: number): number {
    let at = end - 1
    while (at >= 0) {
      const range = blanked(at)
      if (range !== undefined) at = range.start - 1
      else if (/\s/.test(source.charAt(at))) at--
      else return at
    }
    return at
  }

  for (const { items, members } of lists) {
    const continues = members ? CONTINUES_MEMBER : CONTINUES_LINE
    let previous: Node | null = null
    for (const item of items) {
      if (removed.has(item)) continue
      if (previous !== null && needsTerminator(previous) && source[previous.end - 1] !== ';') {
        const next = firstKept(item.start)
        if (continues.has(source.charAt(next))) {
          const at = blankSlot(lastKept(previous.end) + 1, next)
          if (at !== -1) inserts.set(at, ';')
        }
      }
      previous = item
    }
  }

  /** The first blanked, non-line-break offset in `[from, to)`, or -1 (nothing was blanked there). */
  function blankSlot(from: number, to: number): number {
    for (let at = from; at < to; at++) {
      if (blanked(at) !== undefined && !isLineBreak(source.charCodeAt(at))) return at
    }
    return -1
  }

  let out = ''
  let last = 0
  for (const { start, end } of ranges) {
    out += source.slice(last, start)
    for (let at = start; at < end; at++) {
      const insert = inserts.get(at)
      const char = source.charCodeAt(at)
      out += insert ?? (isLineBreak(char) ? source.charAt(at) : ' ')
    }
    last = end
  }
  return out + source.slice(last)
}
