// T3.13: reads a module's import-binding references, `import()` and `import.meta` in one pass over
// oxc-parser's AST. It edits nothing: `apply.ts` turns the result into text.
//
// Scope analysis is purpose-built and deferred: the walk records every reference to an import's
// local name together with the scope it stood in, and every declaration that reuses such a name,
// and `isImportReference` then decides which references are still the import's (nothing else is
// tracked). Scopes follow the language, not Babel: a function's parameters and its body are two
// scopes, so a `var` in the body is invisible to a parameter default; a `switch`'s cases share one
// scope the discriminant is outside of.
import type { ArrowFunctionExpression, Function as FunctionNode, Node, Program } from 'oxc-parser'

/** What an import's local name stands for: a member of the import's namespace, or all of it. */
export interface ImportBinding {
  /** Index N of `__vite_ssr_import_N__`. */
  readonly index: number
  /** The imported name, or `null` for a namespace import. */
  readonly imported: string | null
}

/** How a reference to an import's binding is written, which decides its replacement. */
export type RefKind = 'plain' | 'callee' | 'shorthand'

export interface Scope {
  readonly parent: Scope | null
  /** The import names declared here, so shadowing the import. */
  names: Set<string> | null
}

export interface Reference {
  readonly start: number
  readonly end: number
  readonly name: string
  readonly kind: RefKind
  /** The reference is the first token of an expression statement in a statement list. */
  readonly opensStatement: boolean
  readonly scope: Scope
}

export interface DynamicImport {
  /** Offset of the `import` keyword. */
  readonly start: number
  /** The specifier when it is a string literal. */
  readonly specifier: string | null
}

export interface Walked {
  readonly references: readonly Reference[]
  readonly dynamicImports: readonly DynamicImport[]
  /** Ranges of `import.meta`. */
  readonly metas: readonly { readonly start: number; readonly end: number }[]
  /** An import's name that a module-level declaration redeclares, which the parser let through. */
  readonly redeclared: string | null
}

const SKIP_KEYS: ReadonlySet<string> = new Set(['type', 'start', 'end', 'range', 'loc', 'parent'])

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
}

/** Options of `walkProgram`. */
export interface WalkOptions {
  /**
   * The program is TypeScript (the in-place strip's import elision, D116): type syntax holds no
   * reference (a type annotation, `typeof x` in a type, a `declare` declaration or field), the
   * expression inside `as`, `satisfies`, `!`, `<T>x` and `f<T>` does, and so do decorators, which
   * Oxc's TypeScript transform counts as uses of an import.
   */
  readonly typescript?: boolean
}

/** TypeScript nodes that wrap an expression which stays in the output. */
const TS_EXPRESSIONS: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
])

/**
 * Walks `program` (module declarations included, only where they hold code) and collects what
 * `apply.ts` needs. `imports` maps local names to their bindings; when it is empty only `import()`
 * and `import.meta` are looked for.
 */
export function walkProgram(
  program: Program,
  imports: ReadonlyMap<string, ImportBinding>,
  options: WalkOptions = {},
): Walked {
  const references: Reference[] = []
  const dynamicImports: DynamicImport[] = []
  const metas: { start: number; end: number }[] = []
  const track = imports.size > 0
  const typescript = options.typescript === true

  /** A TypeScript program's decorators (JavaScript's are left as the runner always left them). */
  function visitDecorators(node: object): void {
    if (!typescript) return
    const decorators = (node as { readonly decorators?: readonly Node[] }).decorators
    if (decorators !== undefined) for (const decorator of decorators) visit(decorator)
  }

  function isDeclared(node: object): boolean {
    return typescript && (node as { readonly declare?: boolean }).declare === true
  }

  const top: Scope = { parent: null, names: null }
  let scope: Scope = top
  let varScope: Scope = top
  let statementStart = -1
  let redeclared: string | null = null

  function declare(name: string, into: Scope): void {
    if (!imports.has(name)) return
    // A module-level declaration of an import's name is a redeclaration error. The parser reports
    // every form but a `var` in a `catch` block whose parameter has that name, so the walk keeps
    // the first one for `rewriteModule` to report.
    if (into === top) {
      redeclared ??= name
      return
    }
    into.names ??= new Set()
    into.names.add(name)
  }

  /** Declares the names of a binding pattern in `into`, and visits its defaults and computed keys. */
  function bindPattern(pattern: Node | null, into: Scope | null): void {
    if (pattern === null) return
    switch (pattern.type) {
      case 'Identifier':
        if (into !== null && track) declare(pattern.name, into)
        // An assignment to an import's name is a use of it to Oxc's TypeScript transform.
        else if (into === null && typescript) reference(pattern, 'plain')
        break
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          if (property.type === 'Property') {
            if (property.computed) visit(property.key)
            bindPattern(property.value, into)
          } else bindPattern(property, into)
        }
        break
      case 'ArrayPattern':
        for (const element of pattern.elements) bindPattern(element, into)
        break
      case 'AssignmentPattern':
        bindPattern(pattern.left, into)
        visit(pattern.right)
        break
      case 'RestElement':
        bindPattern(pattern.argument, into)
        break
      default:
        // A member expression as an assignment target.
        visit(pattern)
    }
  }

  function visitList(statements: readonly Node[]): void {
    for (const statement of statements) {
      statementStart = statement.type === 'ExpressionStatement' ? statement.start : -1
      visit(statement)
    }
  }

  function reference(node: { name: string; start: number; end: number }, kind: RefKind): void {
    if (!track || !imports.has(node.name)) return
    references.push({
      start: node.start,
      end: node.end,
      name: node.name,
      kind,
      opensStatement: node.start === statementStart,
      scope,
    })
  }

  function visitChildren(node: Node): void {
    // `for…in` rather than `Object.entries`: the nodes are plain objects, and it allocates nothing.
    const fields = node as unknown as Readonly<Record<string, unknown>>
    for (const key in fields) {
      const value = fields[key]
      if (SKIP_KEYS.has(key) || typeof value !== 'object' || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item)
      } else if (isNode(value)) visit(value)
    }
  }

  function withScope(body: () => void): void {
    const saved = scope
    scope = { parent: saved, names: null }
    body()
    scope = saved
  }

  function visitFunction(node: FunctionNode | ArrowFunctionExpression): void {
    const savedScope = scope
    const savedVar = varScope
    const savedStatement = statementStart
    if (node.type === 'FunctionDeclaration') {
      if (node.id !== null) declare(node.id.name, scope)
    } else if (node.type === 'FunctionExpression' && node.id !== null) {
      // A function expression's own name lives in a scope around its parameters.
      scope = { parent: scope, names: null }
      declare(node.id.name, scope)
    }
    // The parameters' scope.
    scope = { parent: scope, names: null }
    for (const param of node.params) {
      visitDecorators(param)
      bindPattern(param, scope)
    }
    const body = node.body
    if (body !== null && body !== undefined) {
      if (body.type === 'BlockStatement') {
        scope = { parent: scope, names: null }
        varScope = scope
        visitList(body.body)
      } else {
        varScope = scope
        visit(body)
      }
    }
    scope = savedScope
    varScope = savedVar
    statementStart = savedStatement
  }

  function visitClass(node: Extract<Node, { type: 'ClassDeclaration' | 'ClassExpression' }>): void {
    if (isDeclared(node)) return
    const saved = scope
    visitDecorators(node)
    if (node.type === 'ClassDeclaration' && node.id !== null) declare(node.id.name, scope)
    scope = { parent: scope, names: null }
    if (node.id !== null) declare(node.id.name, scope)
    if (node.superClass !== null) visit(node.superClass)
    visit(node.body)
    scope = saved
  }

  function visitVariable(node: Extract<Node, { type: 'VariableDeclaration' }>): void {
    if (isDeclared(node)) return
    const into = node.kind === 'var' ? varScope : scope
    for (const declarator of node.declarations) {
      bindPattern(declarator.id, into)
      if (declarator.init !== null) visit(declarator.init)
    }
  }

  function visit(node: Node): void {
    switch (node.type) {
      case 'Identifier':
        reference(node, 'plain')
        return
      case 'MemberExpression':
        visit(node.object)
        if (node.computed) visit(node.property)
        return
      case 'CallExpression': {
        const callee = node.callee
        if (callee.type === 'Identifier') {
          // oxc leaves a parenthesised callee, `(a)()`, as a plain member read.
          reference(callee, callee.start === node.start ? 'callee' : 'plain')
        } else visit(callee)
        for (const argument of node.arguments) visit(argument)
        return
      }
      case 'Property':
        if (node.computed) visit(node.key)
        if (node.shorthand && node.value.type === 'Identifier' && node.kind === 'init') {
          reference(node.value, 'shorthand')
        } else visit(node.value)
        return
      case 'MethodDefinition':
      case 'PropertyDefinition':
      case 'AccessorProperty':
        if (isDeclared(node)) return
        visitDecorators(node)
        if (node.computed) visit(node.key)
        if (node.value !== null && node.value !== undefined) visit(node.value)
        return
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(node)
        return
      case 'ClassDeclaration':
      case 'ClassExpression':
        visitClass(node)
        return
      case 'BlockStatement':
        withScope(() => visitList(node.body))
        return
      case 'StaticBlock': {
        const savedVar = varScope
        withScope(() => {
          varScope = scope
          visitList(node.body)
        })
        varScope = savedVar
        return
      }
      case 'VariableDeclaration':
        visitVariable(node)
        return
      case 'ForStatement':
        withScope(() => visitChildren(node))
        return
      case 'ForInStatement':
      case 'ForOfStatement':
        withScope(() => {
          const left = node.left
          if (left.type === 'VariableDeclaration') visitVariable(left)
          else bindPattern(left, null)
          visit(node.right)
          visit(node.body)
        })
        return
      case 'CatchClause':
        withScope(() => {
          bindPattern(node.param, scope)
          visit(node.body)
        })
        return
      case 'SwitchStatement':
        visit(node.discriminant)
        withScope(() => {
          for (const switchCase of node.cases) {
            if (switchCase.test !== null) visit(switchCase.test)
            visitList(switchCase.consequent)
          }
        })
        return
      case 'LabeledStatement':
        visit(node.body)
        return
      case 'BreakStatement':
      case 'ContinueStatement':
        return
      case 'AssignmentExpression':
        // `a = 1`, `[a] = x` and `({ a } = x)` leave an import's name as written, as oxc does.
        bindPattern(node.left, null)
        visit(node.right)
        return
      case 'UpdateExpression':
        if (node.argument.type !== 'Identifier' || typescript) visit(node.argument)
        return
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'AssignmentPattern':
      case 'RestElement':
        bindPattern(node, null)
        return
      case 'MetaProperty':
        if (node.meta.name === 'import') metas.push({ start: node.start, end: node.end })
        return
      case 'ImportExpression': {
        const source = node.source
        dynamicImports.push({
          start: node.start,
          specifier:
            source.type === 'Literal' && typeof source.value === 'string' ? source.value : null,
        })
        visit(source)
        if (node.options !== null && node.options !== undefined) visit(node.options)
        return
      }
      default:
        if (typescript && node.type.startsWith('TS')) {
          // Type syntax refers to no value; only the expression an assertion wraps stays.
          if (TS_EXPRESSIONS.has(node.type))
            visit((node as { readonly expression: Node }).expression)
          return
        }
        visitChildren(node)
    }
  }

  for (const statement of program.body) {
    statementStart = statement.type === 'ExpressionStatement' ? statement.start : -1
    switch (statement.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        break
      case 'ExportNamedDeclaration':
        if (statement.declaration !== null) visit(statement.declaration)
        break
      case 'ExportDefaultDeclaration':
        visit(statement.declaration)
        break
      default:
        visit(statement)
    }
  }

  return { references, dynamicImports, metas, redeclared }
}

/** Whether `ref` still means the import (nothing between it and the module declares its name). */
export function isImportReference(ref: Reference): boolean {
  for (let scope: Scope | null = ref.scope; scope !== null; scope = scope.parent) {
    if (scope.names?.has(ref.name) === true) return false
  }
  return true
}
