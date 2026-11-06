// Pulls the hoist cases out of the two upstream test files (B13b, T3.4). Pure: it reads the source
// text it is given, so `extract.test.ts` can run it on small inline sources. `extract-upstream.ts`
// (`pnpm hoist:extract`) reads `.refs/` and writes `vendor/*.json`.
import { parseSync } from 'oxc-parser'

/** One Jest case: `babel-plugin-tester`'s `code`, plus what the Babel presets stood for. */
export interface JestCase {
  readonly name: string
  readonly code: string
  /** The file name Babel was given, which says how the pipeline strips the input. */
  readonly filename: string
  /** Set when the case used `@babel/preset-react` with the automatic runtime. */
  readonly jsx?: 'automatic'
}

/** One Vitest case: the code the upstream test hands to `hoistMockAndResolve`, wrapper included. */
export interface VitestCase {
  readonly name: string
  readonly code: string
}

interface Node {
  readonly type: string
  readonly [key: string]: unknown
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  )
}

function child(node: Node, key: string): Node | undefined {
  const value = node[key]
  return isNode(value) ? value : undefined
}

function children(node: Node, key: string): readonly Node[] {
  const value = node[key]
  return Array.isArray(value) ? value.filter(isNode) : []
}

function parseProgram(filename: string, source: string): Node {
  const result = parseSync(filename, source, { sourceType: 'module' })
  if (result.errors.length > 0) {
    throw new Error(`${filename}: ${result.errors[0]?.message ?? 'parse error'}`)
  }
  const program: unknown = result.program
  if (!isNode(program)) throw new Error(`${filename}: no program`)
  return program
}

/** Every node under `root`, root first, in source order. */
function* walk(root: Node): Generator<Node> {
  yield root
  for (const key of Object.keys(root)) {
    const value = root[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) yield* walk(item)
    } else if (isNode(value)) {
      yield* walk(value)
    }
  }
}

type Scope = ReadonlyMap<string, string>

/** The string a node stands for: a literal, a template with no holes, `+`, `.trim()`, a const. */
function resolveString(node: Node | undefined, scope: Scope): string {
  if (node === undefined) throw new Error('missing string argument')
  switch (node.type) {
    case 'Literal': {
      if (typeof node.value === 'string') return node.value
      break
    }
    case 'TemplateLiteral': {
      if (children(node, 'expressions').length > 0) {
        throw new Error('a template with holes is not a plain input')
      }
      return children(node, 'quasis')
        .map((quasi) => {
          const value: unknown = quasi.value
          const cooked: unknown =
            typeof value === 'object' && value !== null ? Reflect.get(value, 'cooked') : undefined
          if (typeof cooked !== 'string') throw new Error('a template with an invalid escape')
          return cooked
        })
        .join('')
    }
    case 'BinaryExpression': {
      if (node.operator === '+') {
        return (
          resolveString(child(node, 'left'), scope) + resolveString(child(node, 'right'), scope)
        )
      }
      break
    }
    case 'Identifier': {
      const value = typeof node.name === 'string' ? scope.get(node.name) : undefined
      if (value !== undefined) return value
      break
    }
    case 'CallExpression': {
      const callee = child(node, 'callee')
      const property = callee === undefined ? undefined : child(callee, 'property')
      if (
        callee?.type === 'MemberExpression' &&
        property?.name === 'trim' &&
        children(node, 'arguments').length === 0
      ) {
        return resolveString(child(callee, 'object'), scope).trim()
      }
      break
    }
    default:
  }
  throw new Error(`cannot resolve a ${node.type} to a string`)
}

/** The `const x = <string>` declarations directly in a function body. */
function constStrings(body: Node): Scope {
  const scope = new Map<string, string>()
  for (const statement of children(body, 'body')) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const declarator of children(statement, 'declarations')) {
      const id = child(declarator, 'id')
      const init = child(declarator, 'init')
      if (id?.type !== 'Identifier' || typeof id.name !== 'string' || init === undefined) continue
      try {
        scope.set(id.name, resolveString(init, scope))
      } catch {
        // not a string constant: fine, it just can't be an input
      }
    }
  }
  return scope
}

function calleeName(call: Node): string | undefined {
  const callee = child(call, 'callee')
  return callee?.type === 'Identifier' && typeof callee.name === 'string' ? callee.name : undefined
}

/** Appends a suffix to a name already taken, so every case name is unique. */
function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name
  for (let n = 2; taken.has(candidate); n++) candidate = `${name} #${n}`
  taken.add(candidate)
  return candidate
}

function pluginTesterTests(program: Node): Node {
  for (const node of walk(program)) {
    if (node.type !== 'CallExpression' || calleeName(node) !== 'pluginTester') continue
    const options = children(node, 'arguments')[0]
    for (const property of options === undefined ? [] : children(options, 'properties')) {
      const key = child(property, 'key')
      const value = child(property, 'value')
      if (key?.name === 'tests' && value?.type === 'ObjectExpression') return value
    }
  }
  throw new Error('no pluginTester({ tests }) call')
}

function propertyNamed(object: Node, name: string): Node | undefined {
  for (const property of children(object, 'properties')) {
    const key = child(property, 'key')
    if (key?.name === name || key?.value === name) return child(property, 'value')
  }
  return undefined
}

/** The cases of `babel-plugin-jest-hoist`'s `hoistPlugin.nodejs18.test.ts`, in source order. */
export function extractJestCases(source: string): readonly JestCase[] {
  const program = parseProgram('hoistPlugin.test.ts', source)
  const tests = pluginTesterTests(program)
  const taken = new Set<string>()
  const cases: JestCase[] = []
  for (const property of children(tests, 'properties')) {
    const key = child(property, 'key')
    const value = child(property, 'value')
    if (value?.type !== 'ObjectExpression') continue
    const name = uniqueName(resolveString(key, new Map()), taken)
    const codeCall = propertyNamed(value, 'code')
    const input = codeCall === undefined ? undefined : children(codeCall, 'arguments')[0]
    const code = resolveString(input, new Map())
    const babelOptions = propertyNamed(value, 'babelOptions')
    let filename = 'file.js'
    let jsx: 'automatic' | undefined
    if (babelOptions !== undefined) {
      const named = propertyNamed(babelOptions, 'filename')
      const last = named === undefined ? undefined : children(named, 'arguments').at(-1)
      if (last !== undefined) filename = resolveString(last, new Map()).replace(/^.*\//, '')
      const presets = propertyNamed(babelOptions, 'presets')
      const text = presets === undefined ? '' : JSON.stringify(presets)
      if (text.includes('presetReact')) {
        jsx = 'automatic'
        filename = 'file.jsx'
      }
    }
    cases.push({ name, code, filename, ...(jsx === undefined ? {} : { jsx }) })
  }
  return cases
}

/** Calls whose first argument is the code a case feeds the hoister, and what wraps it. */
const VITEST_ENTRIES: Readonly<Record<string, (code: string) => string>> = {
  hoistSimple: (code) => code,
  hoistSimpleCode: (code) => code,
  hoistMockAndResolve: (code) => code,
  hoistSimpleCodeWithoutMocks: (code) => `import {vi} from "vitest";\n${code}\nvi.mock('faker');\n`,
  getErrorWhileHoisting: (code) => code,
}

function functionBody(call: Node, index: number): Node | undefined {
  const fn = children(call, 'arguments')[index]
  if (fn === undefined) return undefined
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return undefined
  return child(fn, 'body')
}

function caseFromBody(name: string, body: Node, taken: Set<string>): VitestCase[] {
  const scope = constStrings(body)
  const out: VitestCase[] = []
  for (const node of walk(body)) {
    if (node.type !== 'CallExpression') continue
    const callee = calleeName(node)
    const wrap = callee === undefined ? undefined : VITEST_ENTRIES[callee]
    if (wrap === undefined) continue
    const [input] = children(node, 'arguments')
    // An `it.each` body calls the helper with the row's code, an identifier no const defines: the
    // rows are read where the table is. Any other input that doesn't resolve is an error.
    if (input?.type === 'Identifier' && !scope.has(String(input.name))) continue
    out.push({ name: uniqueName(name, taken), code: wrap(resolveString(input, scope)) })
  }
  return out
}

function collectVitest(
  statements: readonly Node[],
  path: readonly string[],
  out: VitestCase[],
  taken: Set<string>,
): void {
  for (const statement of statements) {
    if (statement.type !== 'ExpressionStatement') continue
    const call = child(statement, 'expression')
    if (call?.type !== 'CallExpression') continue
    const callee = child(call, 'callee')
    if (callee?.type === 'Identifier') {
      const [title] = children(call, 'arguments')
      if (callee.name === 'describe') {
        const body = functionBody(call, 1)
        if (body !== undefined && title !== undefined) {
          collectVitest(
            children(body, 'body'),
            [...path, resolveString(title, new Map())],
            out,
            taken,
          )
        }
      } else if ((callee.name === 'test' || callee.name === 'it') && title !== undefined) {
        const body = functionBody(call, 1)
        if (body === undefined) continue
        const name = [...path, resolveString(title, new Map())].join(' > ')
        out.push(...caseFromBody(name, body, taken))
      }
    } else if (callee?.type === 'CallExpression') {
      // `it.each([[title, code], …])(name, fn)`
      const each = child(callee, 'callee')
      const property = each === undefined ? undefined : child(each, 'property')
      if (each?.type !== 'MemberExpression' || property?.name !== 'each') continue
      const rows = children(callee, 'arguments')[0]
      const [template] = children(call, 'arguments')
      if (rows === undefined || template === undefined) continue
      const pattern = resolveString(template, new Map())
      for (const row of children(rows, 'elements')) {
        const [title, code] = children(row, 'elements')
        const name = [...path, pattern.replace('%s', resolveString(title, new Map()))].join(' > ')
        out.push({ name: uniqueName(name, taken), code: resolveString(code, new Map()) })
      }
    }
  }
}

/** The cases of `injector-mock.test.ts`, in source order. */
export function extractVitestCases(source: string): readonly VitestCase[] {
  const program = parseProgram('injector-mock.test.ts', source)
  const out: VitestCase[] = []
  collectVitest(children(program, 'body'), [], out, new Set())
  return out
}
