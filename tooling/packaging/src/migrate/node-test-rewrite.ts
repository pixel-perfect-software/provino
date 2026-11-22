// The node:test -> provino rewrite (B27g1). Pure: source text in, source text and refusals out.
// Rewrites only what the native API runs the same way; every other form is refused per site
// (MIGRATE_UNSUPPORTED, file:line) for a hand edit.
import MagicString from 'magic-string'
import { parseSync } from 'oxc-parser'
import { MigrateError } from './errors.ts'

/**
 * One site the codemod will not rewrite.
 * @internal
 */
export interface Refusal {
  readonly code: 'MIGRATE_UNSUPPORTED'
  readonly file: string
  readonly line: number
  readonly column: number
  readonly message: string
}

/**
 * What \`rewriteNodeTest\` found in one file.
 * @internal
 */
export interface RewriteResult {
  /** The migrated source; the input, unchanged, when the file has refusals or no node:test import. */
  readonly text: string
  readonly changed: boolean
  readonly refusals: readonly Refusal[]
}

interface AstNode {
  readonly type: string
  readonly start: number
  readonly end: number
}

type Props = Readonly<Record<string, unknown>>

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Props).type === 'string' &&
  typeof (value as Props).start === 'number'

const get = (node: AstNode, key: string): unknown => (node as unknown as Props)[key]
const nodeOf = (node: AstNode, key: string): AstNode | null => {
  const value = get(node, key)
  return isNode(value) ? value : null
}
const listOf = (node: AstNode, key: string): readonly unknown[] => {
  const value = get(node, key)
  return Array.isArray(value) ? value : []
}
const nameOf = (node: AstNode | null): string | null =>
  node !== null && node.type === 'Identifier' ? String(get(node, 'name')) : null

const SUITES = new Set(['describe', 'suite'])
const TESTS = new Set(['it', 'test'])
const HOOKS: Readonly<Record<string, string>> = {
  before: 'beforeAll',
  after: 'afterAll',
  beforeEach: 'beforeEach',
  afterEach: 'afterEach',
}
const MODIFIERS = new Set(['skip', 'todo', 'only'])
/** Members of the test context the native one has, as written. */
const CONTEXT_SAME = new Set(['skip', 'signal', 'task'])
const KNOWN_IMPORTS = new Set([...SUITES, ...TESTS, ...Object.keys(HOOKS)])

const isFunctionType = (type: string): boolean =>
  type === 'ArrowFunctionExpression' || type === 'FunctionExpression'

function isFunction(node: AstNode | null): node is AstNode {
  return (
    node !== null && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')
  )
}

function patternNames(node: unknown, into: Set<string>): void {
  if (!isNode(node)) return
  if (node.type === 'Identifier') into.add(String(get(node, 'name')))
  for (const value of Object.values(node as unknown as Props)) {
    if (Array.isArray(value)) for (const item of value) patternNames(item, into)
    else if (isNode(value) && value.type !== 'TSTypeAnnotation') patternNames(value, into)
  }
}

interface Mod {
  readonly kind: 'skip' | 'todo' | 'only' | 'skipIf'
  readonly condition?: string
}

/**
 * Rewrites one test file from \`node:test\` to \`provino\`. A file with any refusal is returned
 * unchanged, so a caller that writes the result never writes half a migration.
 * @internal
 */
export function rewriteNodeTest(file: string, source: string): RewriteResult {
  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]
    throw new MigrateError('MIGRATE_PARSE', file + ': ' + (first?.message ?? 'syntax error'))
  }
  const program = parsed.program as unknown as AstNode
  const body = listOf(program, 'body').filter(isNode)
  const imports = body.filter(
    (node) =>
      node.type === 'ImportDeclaration' &&
      get(nodeOf(node, 'source') ?? node, 'value') === 'node:test',
  )
  if (imports.length === 0) return { text: source, changed: false, refusals: [] }

  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1)
  const refusals: Refusal[] = []
  const refuse = (at: AstNode, message: string): void => {
    let line = lineStarts.length - 1
    while ((lineStarts[line] ?? 0) > at.start) line--
    refusals.push({
      code: 'MIGRATE_UNSUPPORTED',
      file,
      line: line + 1,
      column: at.start - (lineStarts[line] ?? 0) + 1,
      message,
    })
  }
  const text = (node: AstNode): string => source.slice(node.start, node.end)

  const [declaration] = imports
  if (declaration === undefined) return { text: source, changed: false, refusals: [] }
  if (imports.length > 1) refuse(imports[1] ?? declaration, 'more than one import from node:test')
  if (
    body.some(
      (node) =>
        node.type === 'ImportDeclaration' &&
        get(nodeOf(node, 'source') ?? node, 'value') === 'provino',
    )
  ) {
    refuse(declaration, "the file already imports from 'provino'")
  }

  // local name -> imported name
  const locals = new Map<string, string>()
  for (const specifier of listOf(declaration, 'specifiers').filter(isNode)) {
    const local = nameOf(nodeOf(specifier, 'local'))
    if (specifier.type === 'ImportNamespaceSpecifier') {
      refuse(specifier, 'namespace import of node:test')
    } else if (specifier.type === 'ImportDefaultSpecifier' && local !== null) {
      locals.set(local, 'test')
    } else if (local !== null) {
      const imported = nodeOf(specifier, 'imported')
      const importedName = nameOf(imported) ?? String(get(imported ?? specifier, 'value'))
      if (importedName === 'mock') {
        locals.set(local, 'mock')
      } else if (KNOWN_IMPORTS.has(importedName)) {
        locals.set(local, importedName)
      } else {
        refuse(specifier, 'node:test export ' + importedName + ' has no native equivalent')
      }
    }
  }
  const shadows: Set<string>[] = []
  const importedOf = (name: string | null): string | undefined =>
    name === null || shadows.some((scope) => scope.has(name)) ? undefined : locals.get(name)

  /** Names a statement list declares in its own scope (var, let, const, function, class). */
  function declaredIn(statements: readonly unknown[]): Set<string> {
    const names = new Set<string>()
    for (const statement of statements.filter(isNode)) {
      if (statement.type === 'VariableDeclaration') {
        for (const declarator of listOf(statement, 'declarations').filter(isNode)) {
          patternNames(nodeOf(declarator, 'id'), names)
        }
      } else if (
        statement.type === 'FunctionDeclaration' ||
        statement.type === 'ClassDeclaration'
      ) {
        const id = nameOf(nodeOf(statement, 'id'))
        if (id !== null) names.add(id)
      }
    }
    return names
  }

  /** Visits a function body with its parameters and own declarations shadowing the imports. */
  function visitBody(fn: AstNode, ctx: string | null): void {
    const names = new Set<string>()
    for (const param of listOf(fn, 'params')) patternNames(param, names)
    const fnBody = nodeOf(fn, 'body')
    if (fnBody !== null && fnBody.type === 'BlockStatement') {
      for (const name of declaredIn(listOf(fnBody, 'body'))) names.add(name)
    }
    shadows.push(names)
    visit(fnBody, fn, ctx)
    shadows.pop()
  }

  const edited = new MagicString(source)
  const needed = new Set<string>()
  const handled = new WeakSet<AstNode>()

  /** A function's own parameters shadow the test context name. */
  function shadowed(fn: AstNode, ctx: string | null): boolean {
    if (ctx === null) return false
    const names = new Set<string>()
    for (const param of listOf(fn, 'params')) patternNames(param, names)
    return names.has(ctx)
  }

  /** The first parameter of a test or beforeEach/afterEach callback: its context name. */
  function contextParameter(fn: AstNode, what: string, allowContext: boolean): string | null {
    const params = listOf(fn, 'params').filter(isNode)
    if (params.length === 0) return null
    const [first] = params
    if (!allowContext) {
      refuse(first ?? fn, what + ' callback takes a parameter (a node:test suite context)')
      return null
    }
    if (params.length > 1) refuse(params[1] ?? fn, what + ' callback uses the done callback')
    const name = nameOf(first ?? null)
    if (name === null) refuse(first ?? fn, what + ' callback destructures the test context')
    return name
  }

  function returnsOf(fn: AstNode): AstNode[] {
    const found: AstNode[] = []
    const walk = (node: unknown): void => {
      if (!isNode(node)) return
      const kind: string = node.type
      if (
        kind === 'ArrowFunctionExpression' ||
        kind === 'FunctionExpression' ||
        kind === 'FunctionDeclaration'
      )
        return
      if (node.type === 'ReturnStatement') {
        const argument = nodeOf(node, 'argument')
        if (argument !== null) found.push(argument)
        return
      }
      for (const value of Object.values(node as unknown as Props)) {
        if (Array.isArray(value)) for (const item of value) walk(item)
        else walk(value)
      }
    }
    const fnBody = nodeOf(fn, 'body')
    if (fnBody === null) return found
    if (fnBody.type === 'BlockStatement') walk(fnBody)
    else found.push(fnBody)
    return found
  }

  function checkReturns(fn: AstNode, isHook: boolean): void {
    for (const value of returnsOf(fn)) {
      if (isHook && isFunction(value)) {
        refuse(value, 'hook returns a function (a node:test hook cleanup is not run by provino)')
      } else if (
        !isHook &&
        ['Literal', 'ArrayExpression', 'ObjectExpression', 'TemplateLiteral'].includes(value.type)
      ) {
        refuse(value, 'test returns a non-promise value (provino fails it)')
      }
    }
  }

  function optionsPlan(
    options: AstNode,
    existingModifier: boolean,
    allowed: readonly string[],
  ): { mods: Mod[]; keep: string[] } {
    const mods: Mod[] = []
    const keep: string[] = []
    for (const prop of listOf(options, 'properties').filter(isNode)) {
      const key = nodeOf(prop, 'key')
      const keyName =
        get(prop, 'computed') === true
          ? null
          : (nameOf(key) ?? (key === null ? null : String(get(key, 'value'))))
      if (prop.type !== 'Property' || keyName === null || get(prop, 'method') === true) {
        refuse(prop, 'option that is not a plain key: value')
        continue
      }
      const value = nodeOf(prop, 'value')
      if (value === null) continue
      const literal = value.type === 'Literal' ? get(value, 'value') : undefined
      if (keyName === 'timeout' && allowed.includes('timeout')) {
        keep.push(text(prop))
      } else if (keyName === 'skip') {
        if (literal === false) continue
        if (value.type === 'Literal') mods.push({ kind: 'skip' })
        else mods.push({ kind: 'skipIf', condition: text(value) })
      } else if (keyName === 'todo' || keyName === 'only') {
        if (literal === false) continue
        if (value.type === 'Literal') mods.push({ kind: keyName })
        else
          refuse(
            prop,
            '{ ' +
              keyName +
              ': <expression> } has no native form (use ' +
              keyName +
              ' on a literal)',
          )
      } else {
        refuse(prop, 'option ' + keyName + ' has no native equivalent')
      }
    }
    if (mods.length > 1 || (mods.length > 0 && existingModifier)) {
      refuse(options, 'more than one skip, todo or only on one test')
    }
    return { mods, keep }
  }

  function classify(call: AstNode): {
    name: string
    role: 'suite' | 'test' | 'hook'
    existing: boolean
    calleeEnd: number
    calleeNode: AstNode
  } | null {
    const callee = nodeOf(call, 'callee')
    if (callee === null) return null
    let base = nameOf(callee)
    let existing = false
    let calleeNode = callee
    if (base === null && callee.type === 'MemberExpression') {
      const object = nodeOf(callee, 'object')
      const property = nodeOf(callee, 'property')
      const propName = nameOf(property)
      if (get(callee, 'computed') !== true && propName !== null && MODIFIERS.has(propName)) {
        base = nameOf(object)
        existing = true
        calleeNode = object ?? callee
      }
    }
    const imported = importedOf(base)
    if (base === null || imported === undefined) return null
    if (SUITES.has(imported))
      return { name: base, role: 'suite', existing, calleeEnd: callee.end, calleeNode }
    if (TESTS.has(imported))
      return { name: base, role: 'test', existing, calleeEnd: callee.end, calleeNode }
    if (imported in HOOKS && !existing)
      return { name: base, role: 'hook', existing, calleeEnd: callee.end, calleeNode }
    return null
  }

  function registration(
    call: AstNode,
    info: NonNullable<ReturnType<typeof classify>>,
    ctx: string | null,
  ): void {
    const args = listOf(call, 'arguments').filter(isNode)
    const imported = importedOf(info.name) ?? ''
    handled.add(info.calleeNode)
    if (info.role === 'hook') {
      const target = HOOKS[imported] ?? imported
      const fn = args[0] ?? null
      const second = args[1] ?? null
      if (!isFunction(fn)) {
        refuse(call, 'hook with a callback that is not an inline function')
        return
      }
      if (target !== imported && info.name === imported)
        edited.overwrite(info.calleeNode.start, info.calleeNode.end, target)
      else if (target !== imported) needed.add(target + ' as ' + info.name)
      if (second !== null) {
        const plan =
          second.type === 'ObjectExpression' ? optionsPlan(second, true, ['timeout']) : null
        const timeout = plan?.keep[0]
        if (
          plan !== null &&
          plan.mods.length === 0 &&
          plan.keep.length === 1 &&
          timeout !== undefined
        ) {
          const value = timeout.slice(timeout.indexOf(':') + 1).trim()
          edited.overwrite(second.start, second.end, value)
        } else if (plan === null) {
          refuse(second, 'hook options that are not an object literal')
        } else if (plan.keep.length > 0 || plan.mods.length > 0) {
          refuse(second, 'hook options other than { timeout }')
        }
      }
      const isSuiteHook = imported === 'before' || imported === 'after'
      const childCtx = contextParameter(fn, imported, !isSuiteHook)
      checkReturns(fn, true)
      visitBody(fn, shadowed(fn, ctx) ? null : childCtx)
      for (const arg of args.slice(1)) visit(arg, call, ctx)
      return
    }

    // describe / it: (name, options?, fn?)
    const name = args[0]
    const rest = args.slice(1)
    const fn =
      rest.length > 0 && isFunction(rest[rest.length - 1] ?? null)
        ? (rest[rest.length - 1] ?? null)
        : null
    const middle = fn === null ? rest : rest.slice(0, -1)
    if (name !== undefined) visit(name, call, ctx)
    let options: AstNode | null = null
    const [candidate] = middle
    if (candidate !== undefined) {
      if (candidate.type === 'ObjectExpression') options = candidate
      else refuse(candidate, 'options that are not an object literal')
      if (middle.length > 1) refuse(middle[1] ?? call, 'unexpected extra argument')
    }
    if (options !== null) {
      const plan = optionsPlan(options, info.existing, ['timeout'])
      const [mod] = plan.mods
      if (mod !== undefined) {
        const suffix =
          mod.kind === 'skipIf' ? '.skipIf(' + (mod.condition ?? '') + ')' : '.' + mod.kind
        edited.appendLeft(info.calleeNode.end, suffix)
      }
      const before = name ?? call
      if (plan.keep.length > 0)
        edited.overwrite(options.start, options.end, '{ ' + plan.keep.join(', ') + ' }')
      else edited.remove(before.end, options.end)
    }
    if (fn === null) return
    if (info.role === 'suite') {
      if (get(fn, 'async') === true) refuse(fn, 'async describe callback')
      if (listOf(fn, 'params').length > 0)
        refuse(fn, 'describe callback takes a parameter (a node:test suite context)')
      visitBody(fn, null)
      return
    }
    const childCtx = contextParameter(fn, 'test', true)
    checkReturns(fn, false)
    visitBody(fn, childCtx)
  }

  function visit(node: unknown, parent: AstNode | null, ctx: string | null): void {
    if (!isNode(node)) return
    if (node.type === 'CallExpression') {
      const info = classify(node)
      if (info !== null) {
        registration(node, info, ctx)
        return
      }
      const callee = nodeOf(node, 'callee')
      if (
        ctx !== null &&
        callee !== null &&
        callee.type === 'MemberExpression' &&
        nameOf(nodeOf(callee, 'object')) === ctx &&
        nameOf(nodeOf(callee, 'property')) === 'after' &&
        get(callee, 'computed') !== true
      ) {
        const args = listOf(node, 'arguments')
        if (args.length !== 1) {
          refuse(node, 't.after with options has no native equivalent')
        } else {
          edited.overwrite(callee.start, callee.end, 'onTestFinished')
          needed.add('onTestFinished')
        }
        for (const arg of args) visit(arg, node, ctx)
        return
      }
    }
    if (
      node.type === 'MemberExpression' &&
      ctx !== null &&
      nameOf(nodeOf(node, 'object')) === ctx
    ) {
      const property = nodeOf(node, 'property')
      const propName = nameOf(property)
      if (get(node, 'computed') === true || propName === null) {
        refuse(node, 'computed access on the test context')
      } else if (propName === 'name') {
        edited.overwrite(node.start, node.end, ctx + '.task.name')
      } else if (!CONTEXT_SAME.has(propName)) {
        refuse(node, ctx + '.' + propName + ' has no native equivalent')
      }
      return
    }
    if (node.type === 'Identifier') {
      const imported = importedOf(String(get(node, 'name')))
      const isMember =
        parent !== null &&
        parent.type === 'MemberExpression' &&
        nodeOf(parent, 'property') === node &&
        get(parent, 'computed') !== true
      const isKey =
        parent !== null &&
        parent.type === 'Property' &&
        nodeOf(parent, 'key') === node &&
        get(parent, 'computed') !== true
      if (imported === 'mock' && !isMember && !isKey)
        refuse(node, 'node:test mock (mock.fn, mock.method, mock.timers) has no codemod')
      else if (
        (imported === 'before' || imported === 'after') &&
        !handled.has(node) &&
        !isMember &&
        !isKey &&
        parent?.type !== 'ImportSpecifier'
      ) {
        refuse(node, 'node:test ' + imported + ' used as a value')
      }
      return
    }
    if (isFunctionType(node.type)) {
      visitBody(node, shadowed(node, ctx) ? null : ctx)
      return
    }
    if (node.type === 'BlockStatement') {
      shadows.push(declaredIn(listOf(node, 'body')))
      for (const statement of listOf(node, 'body')) visit(statement, node, ctx)
      shadows.pop()
      return
    }
    for (const [key, value] of Object.entries(node as unknown as Props)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      if (Array.isArray(value)) for (const item of value) visit(item, node, ctx)
      else visit(value, node, ctx)
    }
  }

  for (const node of body) if (node !== declaration) visit(node, program, null)

  if (refusals.length > 0) return { text: source, changed: false, refusals }

  const specifiers = new Set<string>()
  for (const [local, imported] of locals) {
    if (imported === 'mock') continue
    const target = HOOKS[imported] ?? imported
    if (target !== imported && local !== imported) specifiers.add(target + ' as ' + local)
    else if (target !== imported) specifiers.add(target)
    else specifiers.add(local === imported ? imported : imported + ' as ' + local)
  }
  for (const extra of needed) specifiers.add(extra)
  const sorted = [...specifiers].sort((a, b) => a.localeCompare(b))
  edited.overwrite(
    declaration.start,
    declaration.end,
    'import { ' + sorted.join(', ') + " } from 'provino'",
  )
  return { text: edited.toString(), changed: true, refusals }
}
