// The node:test -> provino rewrite (B27g1). Pure: source text in, source text and refusals out.
// Rewrites only what the native API runs the same way; every other form is refused per site
// (MIGRATE_UNSUPPORTED, file:line) for a hand edit. Names are resolved by scope (oxc-walker's
// ScopeTracker), so a local variable that happens to be called it or describe is left alone.
import MagicString from 'magic-string'
import { parseSync } from 'oxc-parser'
import { ScopeTracker, walk } from 'oxc-walker'
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
 * A refusal as one line: `MIGRATE_UNSUPPORTED file:line:column message`.
 * @internal
 */
export function formatRefusal(refusal: Refusal): string {
  return `${refusal.code} ${refusal.file}:${refusal.line}:${refusal.column} ${refusal.message}`
}

/**
 * What `rewriteNodeTest` found in one file.
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
const listOf = (node: AstNode, key: string): readonly AstNode[] => {
  const value = get(node, key)
  return Array.isArray(value) ? value.filter(isNode) : []
}
const nameOf = (node: AstNode | null | undefined): string | null =>
  node?.type === 'Identifier' ? String(get(node, 'name')) : null
const stringValue = (node: AstNode | null | undefined): string | null =>
  node?.type === 'Literal' && typeof get(node, 'value') === 'string'
    ? String(get(node, 'value'))
    : null

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
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])
const NON_PROMISE = new Set(['Literal', 'ArrayExpression', 'ObjectExpression', 'TemplateLiteral'])

/** An inline callback: an arrow function or a function expression. */
const isCallback = (node: AstNode | null | undefined): node is AstNode =>
  node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'

/** What a function returns directly (a concise body, or each `return` outside nested functions). */
function returnsOf(fn: AstNode): AstNode[] {
  const body = nodeOf(fn, 'body')
  if (body === null) return []
  if (body.type !== 'BlockStatement') return [body]
  const found: AstNode[] = []
  const visit = (node: unknown): void => {
    if (!isNode(node) || FUNCTIONS.has(node.type)) return
    if (node.type === 'ReturnStatement') {
      const argument = nodeOf(node, 'argument')
      if (argument !== null) found.push(argument)
      return
    }
    for (const value of Object.values(node as unknown as Props)) {
      if (Array.isArray(value)) value.forEach(visit)
      else visit(value)
    }
  }
  visit(body)
  return found
}

type Mod =
  | { readonly kind: 'skip' | 'todo' | 'only' }
  | { readonly kind: 'skipIf'; readonly condition: string }

/** A name the file imports from node:test: what it was exported as, and what it is called here. */
interface Imported {
  readonly imported: string
  readonly local: string
}

/** A call that registers a suite, a test or a hook. */
interface Registration {
  readonly role: 'suite' | 'test' | 'hook'
  readonly imported: string
  /** The identifier naming it (`it` in `it.skip(…)`). */
  readonly base: AstNode
  /** Already `.skip`, `.todo` or `.only`. */
  readonly modified: boolean
}

/**
 * Rewrites one test file from `node:test` to `provino`. A file with any refusal is returned
 * unchanged, so a caller that writes the result never writes half a migration.
 * @internal
 */
export function rewriteNodeTest(file: string, source: string): RewriteResult {
  const unchanged: RewriteResult = { text: source, changed: false, refusals: [] }
  if (!source.includes('node:test')) return unchanged
  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) {
    throw new MigrateError(
      'MIGRATE_PARSE',
      `${file}: ${parsed.errors[0]?.message ?? 'syntax error'}`,
    )
  }
  const program = parsed.program as unknown as AstNode

  const refusals: Refusal[] = []
  let lineStarts: number[] | undefined
  const refuse = (at: AstNode, message: string): void => {
    if (lineStarts === undefined) {
      lineStarts = [0]
      for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1)
    }
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

  // The import declaration, and the names it brings in.
  const imports = listOf(program, 'body').filter(
    (node) =>
      node.type === 'ImportDeclaration' && stringValue(nodeOf(node, 'source')) === 'node:test',
  )
  const declaration = imports[0]
  if (imports.length > 1) refuse(imports[1] ?? program, 'more than one import from node:test')
  const locals = new Map<string, Imported>()
  const providerImports = listOf(program, 'body').filter(
    (node) =>
      node.type === 'ImportDeclaration' && stringValue(nodeOf(node, 'source')) === 'provino',
  )
  if (declaration !== undefined && providerImports.length > 0) {
    refuse(declaration, "the file already imports from 'provino'")
  }
  if (declaration !== undefined && get(declaration, 'importKind') === 'type') {
    refuse(declaration, 'type import from node:test: write the type by hand')
  } else if (declaration !== undefined) {
    const specifiers = listOf(declaration, 'specifiers')
    if (specifiers.length === 0) refuse(declaration, 'side-effect import of node:test')
    for (const specifier of specifiers) {
      const local = nameOf(nodeOf(specifier, 'local'))
      if (specifier.type === 'ImportNamespaceSpecifier' || local === null) {
        refuse(specifier, 'namespace import of node:test')
        continue
      }
      const importedNode = nodeOf(specifier, 'imported')
      const imported =
        specifier.type === 'ImportDefaultSpecifier'
          ? 'test'
          : (nameOf(importedNode) ?? stringValue(importedNode) ?? '')
      if (imported === 'mock' || KNOWN_IMPORTS.has(imported)) {
        locals.set(local, { imported, local })
      } else {
        refuse(specifier, `node:test export ${imported} has no native equivalent`)
      }
    }
  }

  const edited = new MagicString(source)
  const needed = new Set<string>()
  const tracker = new ScopeTracker()
  /** Where each test context parameter starts: the binding a `t.name` must resolve to. */
  const contextParameters = new Set<number>()

  /** The import a name stands for here: not a local that shadows it. */
  const importOf = (name: string | null): Imported | undefined => {
    const found = name === null ? undefined : locals.get(name)
    return found !== undefined && tracker.getDeclaration(found.local)?.type === 'Import'
      ? found
      : undefined
  }

  function classify(call: AstNode): Registration | null {
    const callee = nodeOf(call, 'callee')
    if (callee === null) return null
    let base = callee
    let modified = false
    if (callee.type === 'MemberExpression' && get(callee, 'computed') !== true) {
      const property = nameOf(nodeOf(callee, 'property'))
      const object = nodeOf(callee, 'object')
      if (property !== null && MODIFIERS.has(property) && object !== null) {
        base = object
        modified = true
      }
    }
    const found = importOf(nameOf(base))
    if (found === undefined) return null
    const { imported } = found
    if (SUITES.has(imported)) return { role: 'suite', imported, base, modified }
    if (TESTS.has(imported)) return { role: 'test', imported, base, modified }
    if (imported in HOOKS && !modified) return { role: 'hook', imported, base, modified }
    return null
  }

  /** beforeAll and afterAll: the call site is renamed when the local name was the imported one. */
  function renameCallee(reg: Registration): void {
    const native = HOOKS[reg.imported]
    if (native !== undefined && native !== reg.imported && nameOf(reg.base) === reg.imported) {
      edited.overwrite(reg.base.start, reg.base.end, native)
    }
  }

  /** The test context a callback names as its first parameter; refuses the forms that cannot work. */
  function contextOf(fn: AstNode, what: string): void {
    const params = listOf(fn, 'params')
    const [first] = params
    if (first === undefined) return
    if (params.length > 1) refuse(params[1] ?? fn, `${what} callback uses the done callback`)
    if (first.type === 'Identifier') contextParameters.add(first.start)
    else refuse(first, `${what} callback destructures the test context`)
  }

  function checkReturns(fn: AstNode, hook: boolean): void {
    for (const value of returnsOf(fn)) {
      if (hook && isCallback(value)) {
        refuse(value, 'hook returns a function (a node:test hook cleanup is not run by provino)')
      } else if (!hook && NON_PROMISE.has(value.type)) {
        refuse(value, 'test returns a non-promise value (provino fails it)')
      }
    }
  }

  /** `{ skip, todo, only, timeout }` of a test or suite: the one modifier and the timeout text. */
  function optionsPlan(
    options: AstNode,
    modified: boolean,
  ): { mod: Mod | undefined; timeout: string | undefined } {
    const mods: Mod[] = []
    let timeout: string | undefined
    for (const prop of listOf(options, 'properties')) {
      const key = nodeOf(prop, 'key')
      const keyName = get(prop, 'computed') === true ? null : (nameOf(key) ?? stringValue(key))
      const value = nodeOf(prop, 'value')
      if (
        prop.type !== 'Property' ||
        keyName === null ||
        value === null ||
        get(prop, 'method') === true
      ) {
        refuse(prop, 'option that is not a plain key: value')
        continue
      }
      const literal = value.type === 'Literal'
      if (keyName === 'timeout') {
        timeout = text(value)
      } else if (keyName === 'skip') {
        if (literal && !get(value, 'value')) continue
        mods.push(literal ? { kind: 'skip' } : { kind: 'skipIf', condition: text(value) })
      } else if (keyName === 'todo' || keyName === 'only') {
        if (literal && !get(value, 'value')) continue
        if (literal) mods.push({ kind: keyName })
        else refuse(prop, `{ ${keyName}: <expression> } has no native form (use a literal)`)
      } else {
        refuse(prop, `option ${keyName} has no native equivalent`)
      }
    }
    if (mods.length > 1 || (mods.length > 0 && modified)) {
      refuse(options, 'more than one skip, todo or only on one test')
    }
    return { mod: mods[0], timeout }
  }

  function registerHook(call: AstNode, reg: Registration): void {
    const [fn, options] = listOf(call, 'arguments')
    if (!isCallback(fn)) {
      refuse(call, 'hook with a callback that is not an inline function')
      return
    }
    renameCallee(reg)
    if (options !== undefined) {
      const props = options.type === 'ObjectExpression' ? listOf(options, 'properties') : []
      const only = props.length === 1 ? props[0] : undefined
      const timeout = only === undefined ? null : nodeOf(only, 'value')
      if (only !== undefined && timeout !== null && nameOf(nodeOf(only, 'key')) === 'timeout') {
        edited.overwrite(options.start, options.end, text(timeout))
      } else {
        refuse(options, 'hook options other than { timeout }')
      }
    }
    if (reg.imported === 'beforeEach' || reg.imported === 'afterEach') contextOf(fn, reg.imported)
    else if (listOf(fn, 'params').length > 0) {
      refuse(fn, `${reg.imported} callback takes a parameter (a node:test suite context)`)
    }
    checkReturns(fn, true)
  }

  function registerTest(call: AstNode, reg: Registration): void {
    const [name, ...rest] = listOf(call, 'arguments')
    const last = rest.at(-1)
    const fn = isCallback(last) ? last : null
    const [options, ...extra] = fn === null ? rest : rest.slice(0, -1)
    if (options !== undefined && name !== undefined) {
      if (options.type === 'ObjectExpression') {
        const { mod, timeout } = optionsPlan(options, reg.modified)
        if (mod !== undefined) {
          edited.appendLeft(
            reg.base.end,
            mod.kind === 'skipIf' ? `.skipIf(${mod.condition})` : `.${mod.kind}`,
          )
        }
        if (timeout === undefined) edited.remove(name.end, options.end)
        else edited.overwrite(options.start, options.end, `{ timeout: ${timeout} }`)
      } else {
        refuse(options, 'options that are not an object literal')
      }
    }
    if (extra[0] !== undefined) refuse(extra[0], 'unexpected extra argument')
    if (fn === null) return
    if (reg.role === 'suite') {
      if (get(fn, 'async') === true) refuse(fn, 'async describe callback')
      if (listOf(fn, 'params').length > 0) {
        refuse(fn, 'describe callback takes a parameter (a node:test suite context)')
      }
    } else {
      contextOf(fn, 'test')
      checkReturns(fn, false)
    }
  }

  /** `t.name`, `t.after` and the members with no native form, on a test context parameter. */
  function contextMember(node: AstNode, parent: AstNode | null): void {
    const object = nodeOf(node, 'object')
    const objectName = nameOf(object)
    if (objectName === null) return
    const declared = tracker.getDeclaration(objectName)
    if (
      declared?.type !== 'FunctionParam' ||
      !contextParameters.has((declared.node as AstNode).start)
    ) {
      return
    }
    const property = get(node, 'computed') === true ? null : nameOf(nodeOf(node, 'property'))
    if (property === null) {
      refuse(node, 'computed access on the test context')
    } else if (property === 'name') {
      edited.overwrite(node.start, node.end, `${objectName}.task.name`)
    } else if (property === 'after') {
      const call =
        parent?.type === 'CallExpression' && nodeOf(parent, 'callee') === node ? parent : null
      if (call === null || listOf(call, 'arguments').length !== 1) {
        refuse(node, `${objectName}.after with options, or not called, has no native equivalent`)
      } else {
        edited.overwrite(node.start, node.end, 'onTestFinished')
        needed.add('onTestFinished')
      }
    } else if (!CONTEXT_SAME.has(property)) {
      refuse(node, `${objectName}.${property} has no native equivalent`)
    }
  }

  /** An imported name used other than as a call: only `mock`, `before` and `after` cannot be left. */
  function valueUse(node: AstNode, parent: AstNode | null): void {
    const found = importOf(nameOf(node))
    if (
      found === undefined ||
      (found.imported !== 'mock' && found.imported !== 'before' && found.imported !== 'after')
    ) {
      return
    }
    if (parent === null) return
    const callee = parent.type === 'CallExpression' && nodeOf(parent, 'callee') === node
    const member =
      parent.type === 'MemberExpression' &&
      nodeOf(parent, 'property') === node &&
      get(parent, 'computed') !== true
    const key =
      parent.type === 'Property' &&
      nodeOf(parent, 'key') === node &&
      get(parent, 'shorthand') !== true
    const importName = parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier'
    if (found.imported === 'mock' && !member && !key && !importName) {
      refuse(node, 'node:test mock (mock.fn, mock.method, mock.timers) has no codemod')
    } else if (found.imported !== 'mock' && !callee && !member && !key && !importName) {
      refuse(node, `node:test ${found.imported} used as a value`)
    }
  }

  /** The other ways to reach node:test: import(), require() and re-exports. */
  function otherReach(node: AstNode): void {
    const fromNodeTest = (value: AstNode | null): boolean => stringValue(value) === 'node:test'
    if (node.type === 'ImportExpression' && fromNodeTest(nodeOf(node, 'source'))) {
      refuse(node, "dynamic import('node:test') has no codemod")
    } else if (
      node.type === 'CallExpression' &&
      nameOf(nodeOf(node, 'callee')) === 'require' &&
      fromNodeTest(listOf(node, 'arguments')[0] ?? null)
    ) {
      refuse(node, "require('node:test') has no codemod")
    } else if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      fromNodeTest(nodeOf(node, 'source'))
    ) {
      refuse(node, 're-export from node:test has no codemod')
    }
  }

  walk(program as never, {
    scopeTracker: tracker,
    enter(node, parent) {
      const at = node as unknown as AstNode
      const above = parent as unknown as AstNode | null
      otherReach(at)
      if (at.type === 'CallExpression') {
        const reg = classify(at)
        if (reg === null) return
        if (reg.role === 'hook') registerHook(at, reg)
        else registerTest(at, reg)
      } else if (at.type === 'MemberExpression') {
        contextMember(at, above)
      } else if (at.type === 'Identifier') {
        valueUse(at, above)
      }
    },
  })

  if (refusals.length > 0) return { text: source, changed: false, refusals }
  if (declaration === undefined) return unchanged

  const specifiers = new Set(needed)
  for (const { imported, local } of locals.values()) {
    if (imported === 'mock') continue
    const native = HOOKS[imported] ?? imported
    const now = local === imported ? native : local
    specifiers.add(now === native ? native : `${native} as ${now}`)
  }
  if (specifiers.size === 0) {
    const newline = source[declaration.end] === '\n' ? 1 : 0
    edited.remove(declaration.start, declaration.end + newline)
  } else {
    const sorted = [...specifiers].sort((a, b) => a.localeCompare(b))
    edited.overwrite(
      declaration.start,
      declaration.end,
      `import { ${sorted.join(', ')} } from 'provino'`,
    )
  }
  return { text: edited.toString(), changed: true, refusals }
}
