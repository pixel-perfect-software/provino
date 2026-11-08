// What the hoist corpus compares first (B13b, T3.4): the hoisted order, not the output text. Three
// hoisters print three shapes: Babel keeps `import`s and writes `_getJestObj().mock('x')`, ours
// writes `const __provino_import_N__ = await import('x')`, and Vitest's is `__vi_import_N__`.
// `orderOf` reads any of them into one neutral sequence, so the check can't pass by comparing text
// and can't pass by normalizing everything away: a hoisted call and a module load keep their
// relative order within a block. It never runs the code, so it can't see a lost binding;
// `run-recorded.ts` does that.
import { parseSync } from 'oxc-parser'
import { isRecord, prop } from '../internal/guards.ts'

/**
 * The events of one block (a statement list: the program, a function body, a plain block), in
 * execution order. `mock:./a` is a hoistable call with its specifier (a literal or a template with
 * no expressions; `mock:<dynamic>` for anything else, `hoisted` and `enableAutomock` for a call with
 * no specifier), `load:./a` is a module load: a `require`, an `import()` or a static import
 * (`load:<dynamic>` when the argument isn't static), and `const:x` is a declaration a hoisted call
 * reads.
 */
export interface BlockOrder {
  /** How many statement lists enclose this one (0 is the program). */
  readonly depth: number
  /** What the enclosing statement lists belong to: `program/call:beforeEach/IfStatement`. */
  readonly owner: string
  readonly events: readonly string[]
}

/** The blocks that have at least one event, in the order their statement lists open. */
export type HoistOrder = readonly BlockOrder[]

/** Where a static `import` runs relative to the hoisted calls in the same program. */
export type StaticImportModel =
  /** Imports evaluate before any statement: real ESM, and the module runner, which moves them up. */
  | 'first'
  /** A CommonJS conversion after hoisting (babel-jest): the requires follow the hoisted calls. */
  | 'after-hoisted'

export interface OrderOptions {
  /** The calls the hoister moves (`mock`, `unmock`, …, `hoisted`): by method name. */
  readonly hoistedNames: ReadonlySet<string>
  /** Modules that are the runner itself (`vitest`, `@jest/globals`): their loads aren't events. */
  readonly runnerModules: ReadonlySet<string>
  readonly staticImports: StaticImportModel
  /** Calls that never move but are read as events, so one that wrongly moves shows (`doMock`). */
  readonly trackedNames?: ReadonlySet<string>
  /** `tsx` for output that keeps JSX and types (Babel's plugin alone). Defaults to JavaScript. */
  readonly syntax?: 'js' | 'tsx'
}

export interface Node {
  readonly type: string
  readonly [key: string]: unknown
}

export function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  )
}

export function child(node: Node, key: string): Node | undefined {
  const value = node[key]
  return isNode(value) ? value : undefined
}

export function startOf(node: Node): number {
  return typeof node.start === 'number' ? node.start : 0
}

/** Each node directly under `node`, in key order. */
export function childrenOf(node: Node): readonly Node[] {
  const out: Node[] = []
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item)
    } else if (isNode(value)) {
      out.push(value)
    }
  }
  return out
}

const BLOCKS = new Set(['Program', 'BlockStatement', 'StaticBlock'])
const FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'])

/** What a `specifier` position holds when it isn't static. */
const DYNAMIC = '<dynamic>'

/**
 * The static value of a specifier: a string literal, a template with no expressions, or the same
 * inside `import(…)` or `await import(…)`.
 */
export function specifierOf(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'ImportExpression') return specifierOf(child(node, 'source'))
  if (node.type === 'AwaitExpression') return specifierOf(child(node, 'argument'))
  if (node.type === 'TemplateLiteral') {
    const expressions = node.expressions
    const quasis = node.quasis
    if (!Array.isArray(expressions) || expressions.length > 0 || !Array.isArray(quasis)) {
      return undefined
    }
    const value: unknown = isNode(quasis[0]) ? quasis[0].value : undefined
    const cooked: unknown = isRecord(value) ? prop(value, 'cooked') : undefined
    return typeof cooked === 'string' ? cooked : undefined
  }
  return undefined
}

interface Found {
  readonly at: number
  readonly event: string
  /** A static `import` or `export … from`, whose place depends on the model. */
  readonly isStatic: boolean
  /** Whether it can sit in the block a CommonJS conversion keeps above its requires. */
  readonly leads: boolean
  /** A const leads only when a hoisted call follows it. */
  readonly isConst: boolean
}

function argumentsOf(call: Node): readonly Node[] {
  const args = call.arguments
  return Array.isArray(args) ? args.filter(isNode) : []
}

/** `import()` or `await import()`: as `vi.mock`'s argument it names a module, and loads nothing. */
function isImportArgument(node: Node | undefined): boolean {
  if (node === undefined) return false
  if (node.type === 'ImportExpression') return true
  return node.type === 'AwaitExpression' && child(node, 'argument')?.type === 'ImportExpression'
}

/** The root of a call chain: `a` in `a.b().c()`, `a()` in `a().b().c()`. */
export function chainRoot(callee: Node): Node {
  let at = callee
  for (;;) {
    const next = at.type === 'MemberExpression' ? child(at, 'object') : undefined
    if (next === undefined) return at
    const inner = next.type === 'CallExpression' ? child(next, 'callee') : undefined
    if (inner?.type !== 'MemberExpression') return next
    at = inner
  }
}

/** Babel's plugin writes the object of every call it hoists as `_getJestObj()`. */
export function isJestGetterCall(node: Node): boolean {
  if (node.type !== 'CallExpression') return false
  const callee = child(node, 'callee')
  return (
    callee?.type === 'Identifier' &&
    typeof callee.name === 'string' &&
    /^_getJestObj\d*$/.test(callee.name)
  )
}

function identifierNames(node: Node, out: Set<string>): void {
  if (node.type === 'Identifier' && typeof node.name === 'string') out.add(node.name)
  for (const item of childrenOf(node)) identifierNames(item, out)
}

function moduleEvent(node: Node | undefined): string {
  return `load:${specifierOf(node) ?? DYNAMIC}`
}

interface Collector {
  readonly options: OrderOptions
  readonly found: Found[]
  /** Every name the hoisted calls in this block read. */
  readonly reads: Set<string>
}

/** The events directly in `statement`: not inside a nested function or block. */
function collect(node: Node, state: Collector): void {
  const { options, found } = state
  // A nested function or block is a block of its own (see `visit`).
  if (FUNCTIONS.has(node.type) || BLOCKS.has(node.type)) return
  const at = startOf(node)
  let skip: Node | undefined
  const push = (event: string, flags?: { isStatic?: boolean; leads?: boolean }): void => {
    found.push({
      at,
      event,
      isStatic: flags?.isStatic === true,
      leads: flags?.leads === true,
      isConst: false,
    })
  }
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration': {
      const source = specifierOf(child(node, 'source'))
      // Types stay in Babel's output, and a type-only import never loads anything.
      const typeOnly = node.importKind === 'type' || node.exportKind === 'type'
      if (source !== undefined && !typeOnly && !options.runnerModules.has(source)) {
        push(`load:${source}`, { isStatic: true })
      }
      break
    }
    case 'ImportExpression': {
      const source = specifierOf(node)
      if (source === undefined || !options.runnerModules.has(source)) {
        push(moduleEvent(node))
      }
      break
    }
    case 'CallExpression': {
      const callee = child(node, 'callee')
      if (callee?.type === 'Identifier' && callee.name === 'require') {
        const first = argumentsOf(node)[0]
        const source = specifierOf(first)
        if (source === undefined || !options.runnerModules.has(source)) {
          push(moduleEvent(first))
        }
      } else if (callee?.type === 'MemberExpression') {
        const property = child(callee, 'property')
        const name = property?.type === 'Identifier' ? property.name : undefined
        const isHoisted = typeof name === 'string' && options.hoistedNames.has(name)
        const isTracked = typeof name === 'string' && options.trackedNames?.has(name) === true
        if (typeof name === 'string' && (isHoisted || isTracked)) {
          const args = argumentsOf(node)
          const first = args[0]
          if (isImportArgument(first)) skip = first
          if (isHoisted) for (const arg of args) identifierNames(arg, state.reads)
          found.push({
            // The method's own position, so a chain (`a.mock(x).mock(y)`) reads in call order.
            at: property === undefined ? at : startOf(property),
            event: eventOfCall(name, first),
            isStatic: false,
            leads: isHoisted && isJestGetterCall(chainRoot(callee)),
            isConst: false,
          })
        }
      }
      break
    }
    default:
  }
  for (const item of childrenOf(node)) if (item !== skip) collect(item, state)
}

function eventOfCall(name: string, first: Node | undefined): string {
  if (first === undefined || FUNCTIONS.has(first.type)) return name
  return `${name}:${specifierOf(first) ?? DYNAMIC}`
}

function boundNames(pattern: Node | undefined, out: string[]): void {
  if (pattern === undefined) return
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
    out.push(pattern.name)
    return
  }
  if (pattern.type === 'Property') {
    boundNames(child(pattern, 'value'), out)
  } else if (pattern.type === 'AssignmentPattern') {
    boundNames(child(pattern, 'left'), out)
  } else if (pattern.type === 'RestElement') {
    boundNames(child(pattern, 'argument'), out)
  } else {
    for (const item of childrenOf(pattern)) boundNames(item, out)
  }
}

/**
 * Names a tool made up, which a factory can read but nobody wrote. The rewritten imports are the
 * `load:` events already, and `_jsxFileName` is a dev-only `var`: it only reaches a debug field, and
 * Babel and Oxc each put it somewhere else.
 */
const GENERATED_NAME =
  /^(?:__provino_import_\d+__|__provino_ref_\d+__|__vi_import_\d+__|_jsxFileName)$/

/** `const:x` for each declaration directly in the block that a hoisted call here reads. */
function constEvents(body: readonly unknown[], reads: ReadonlySet<string>): readonly Found[] {
  const out: Found[] = []
  for (const statement of body) {
    if (!isNode(statement)) continue
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? child(statement, 'declaration') : statement
    if (declaration?.type !== 'VariableDeclaration') continue
    const declarators = declaration.declarations
    if (!Array.isArray(declarators)) continue
    for (const declarator of declarators) {
      if (!isNode(declarator)) continue
      const names: string[] = []
      boundNames(child(declarator, 'id'), names)
      for (const name of names) {
        if (reads.has(name) && !GENERATED_NAME.test(name)) {
          out.push({
            at: startOf(declarator),
            event: `const:${name}`,
            isStatic: false,
            leads: true,
            isConst: true,
          })
        }
      }
    }
  }
  return out
}

function blockEvents(
  body: readonly unknown[],
  options: OrderOptions,
  isProgram: boolean,
): readonly string[] {
  const state: Collector = { options, found: [], reads: new Set() }
  for (const statement of body) if (isNode(statement)) collect(statement, state)
  const found = [...state.found, ...constEvents(body, state.reads)].sort((a, b) => a.at - b.at)
  const statics = found.filter((item) => item.isStatic)
  const rest = found.filter((item) => !item.isStatic)
  if (!isProgram || statics.length === 0) return found.map((item) => item.event)
  if (options.staticImports === 'first') {
    return [...statics, ...rest].map((item) => item.event)
  }
  // After the leading run of hoisted statements. A const at its end is one that stayed where it was.
  let lead = 0
  while (lead < rest.length && rest[lead]?.leads === true) lead++
  while (lead > 0 && rest[lead - 1]?.isConst === true) lead--
  return [...rest.slice(0, lead), ...statics, ...rest.slice(lead)].map((item) => item.event)
}

function calleeName(call: Node): string {
  const callee = child(call, 'callee')
  if (callee?.type === 'Identifier' && typeof callee.name === 'string') return callee.name
  const property = callee?.type === 'MemberExpression' ? child(callee, 'property') : undefined
  return property?.type === 'Identifier' && typeof property.name === 'string'
    ? property.name
    : 'call'
}

function keyName(node: Node): string {
  const key = child(node, 'key')
  if (key?.type === 'Identifier' && typeof key.name === 'string') return key.name
  return key?.type === 'Literal' ? String(key.value) : 'computed'
}

/** What a function belongs to, read from its parent and whatever it is called. */
function functionLabel(fn: Node, parent: Node | undefined): string {
  const id = child(fn, 'id')
  if (id?.type === 'Identifier' && typeof id.name === 'string') return `function:${id.name}`
  if (parent === undefined) return 'function'
  switch (parent.type) {
    case 'CallExpression':
    case 'NewExpression':
      return `call:${calleeName(parent)}`
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return `method:${keyName(parent)}`
    case 'VariableDeclarator': {
      const name = child(parent, 'id')
      return name?.type === 'Identifier' && typeof name.name === 'string'
        ? `function:${name.name}`
        : 'function'
    }
    default:
      return 'function'
  }
}

function blockLabel(node: Node, ancestors: readonly Node[]): string {
  if (node.type === 'Program') return 'program'
  if (node.type === 'StaticBlock') return 'StaticBlock'
  const parent = ancestors.at(-1)
  if (parent === undefined) return node.type
  return FUNCTIONS.has(parent.type) ? functionLabel(parent, ancestors.at(-2)) : parent.type
}

interface Visit {
  readonly options: OrderOptions
  readonly out: BlockOrder[]
}

function visit(
  node: Node,
  state: Visit,
  depth: number,
  owner: string,
  ancestors: readonly Node[],
): void {
  let innerDepth = depth
  let innerOwner = owner
  const open = (label: string, body: readonly unknown[], isProgram: boolean): void => {
    innerOwner = owner === '' ? label : `${owner}/${label}`
    // Pushed before descending, so the order is the order statement lists open (pre-order).
    state.out.push({
      depth,
      owner: innerOwner,
      events: blockEvents(body, state.options, isProgram),
    })
    innerDepth = depth + 1
  }
  if (BLOCKS.has(node.type)) {
    const body = node.body
    open(blockLabel(node, ancestors), Array.isArray(body) ? body : [], node.type === 'Program')
  } else if (FUNCTIONS.has(node.type)) {
    // `() => require('x')`: an expression body is a statement list of one.
    const body = child(node, 'body')
    if (body !== undefined && !BLOCKS.has(body.type)) {
      open(functionLabel(node, ancestors.at(-1)), [body], false)
    }
  }
  const below = [...ancestors, node]
  for (const item of childrenOf(node)) visit(item, state, innerDepth, innerOwner, below)
}

/**
 * Reads `code` (a module) into its hoisted order. Throws if it doesn't parse: a hoister that prints
 * invalid code must fail the check.
 */
export function orderOf(code: string, options: OrderOptions): HoistOrder {
  const filename = options.syntax === 'tsx' ? 'hoisted.tsx' : 'hoisted.mjs'
  const result = parseSync(filename, code, { sourceType: 'module' })
  if (result.errors.length > 0) {
    throw new Error(`the hoisted code does not parse: ${result.errors[0]?.message ?? 'error'}`)
  }
  const program: unknown = result.program
  if (!isNode(program)) throw new Error('the hoisted code has no program')
  const out: BlockOrder[] = []
  visit(program, { options, out }, 0, '', [])
  return out.filter((block) => block.events.length > 0)
}

/** One line per block, for a failure message. */
export function formatOrder(order: HoistOrder): string {
  if (order.length === 0) return '(no events)'
  return order
    .map((block, index) => `block ${index} (${block.owner}): ${block.events.join(' > ')}`)
    .join('\n')
}

/** Whether two orders are the same sequence in every block. */
export function sameOrder(a: HoistOrder, b: HoistOrder): boolean {
  return (
    a.length === b.length &&
    a.every((block, index) => {
      const other = b[index]
      return (
        other !== undefined &&
        block.depth === other.depth &&
        block.owner === other.owner &&
        block.events.length === other.events.length &&
        block.events.every((event, i) => event === other.events[i])
      )
    })
  )
}
