// What the hoist corpus compares (B13b, T3.4): the hoisted order, not the output text. Three
// hoisters print three shapes: Babel keeps `import`s and writes `_getJestObj().mock('x')`, ours
// writes `const __provino_import_N__ = await import('x')`, and Vitest's is `__vi_import_N__`.
// `orderOf` reads any of them into one neutral sequence, so the check can't pass by comparing text
// and can't pass by normalizing everything away: a hoisted call and a module load keep their
// relative order within a block.
import { parseSync } from 'oxc-parser'

/**
 * The events of one block (a statement list: the program, a function body, a plain block), in
 * execution order. `mock:./a` is a hoistable call with its literal specifier (`hoisted` has none),
 * `load:./a` is a module load: a `require`, an `await import()` or a static import.
 */
export interface BlockOrder {
  /** How many statement lists enclose this one (0 is the program). */
  readonly depth: number
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
  /** `tsx` for output that keeps JSX and types (Babel's plugin alone). Defaults to JavaScript. */
  readonly syntax?: 'js' | 'tsx'
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

function startOf(node: Node): number {
  return typeof node.start === 'number' ? node.start : 0
}

const BLOCKS = new Set(['Program', 'BlockStatement', 'StaticBlock'])
const FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'])

/** A string literal's value, or the specifier of `import('x')`, or undefined. */
function specifierOf(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'ImportExpression') return specifierOf(child(node, 'source'))
  return undefined
}

interface Found {
  readonly at: number
  readonly event: string
  /** A static `import` or `export … from`, whose place depends on the model. */
  readonly isStatic: boolean
  readonly isHoisted: boolean
}

function firstArgument(call: Node): Node | undefined {
  const args = call.arguments
  return Array.isArray(args) && isNode(args[0]) ? args[0] : undefined
}

/** The events directly in `statement`: not inside a nested function or block. */
function collect(node: Node, options: OrderOptions, out: Found[]): void {
  // A nested function or block is a block of its own (see `visit`).
  if (FUNCTIONS.has(node.type) || BLOCKS.has(node.type)) {
    return
  }
  const at = startOf(node)
  let skip: Node | undefined
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration': {
      const source = specifierOf(child(node, 'source'))
      if (source !== undefined && !options.runnerModules.has(source)) {
        out.push({ at, event: `load:${source}`, isStatic: true, isHoisted: false })
      }
      break
    }
    case 'ImportExpression': {
      const source = specifierOf(node)
      if (source !== undefined && !options.runnerModules.has(source)) {
        out.push({ at, event: `load:${source}`, isStatic: false, isHoisted: false })
      }
      break
    }
    case 'CallExpression': {
      const callee = child(node, 'callee')
      if (callee?.type === 'Identifier' && callee.name === 'require') {
        const source = specifierOf(firstArgument(node))
        if (source !== undefined && !options.runnerModules.has(source)) {
          out.push({ at, event: `load:${source}`, isStatic: false, isHoisted: false })
        }
      } else if (callee?.type === 'MemberExpression') {
        const property = child(callee, 'property')
        const name = property?.type === 'Identifier' ? property.name : undefined
        if (typeof name === 'string' && options.hoistedNames.has(name)) {
          const first = firstArgument(node)
          const source = specifierOf(first)
          // `vi.mock(import('./p'))` names a module; it doesn't load one.
          if (first?.type === 'ImportExpression') skip = first
          out.push({
            // The method's own position, so a chain (`a.mock(x).mock(y)`) reads in call order.
            at: property === undefined ? at : startOf(property),
            event: source === undefined ? name : `${name}:${source}`,
            isStatic: false,
            isHoisted: true,
          })
        }
      }
      break
    }
    default:
  }
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item) && item !== skip) collect(item, options, out)
    } else if (isNode(value) && value !== skip) {
      collect(value, options, out)
    }
  }
}

function blockEvents(
  body: readonly unknown[],
  options: OrderOptions,
  isProgram: boolean,
): readonly string[] {
  const found: Found[] = []
  for (const statement of body) if (isNode(statement)) collect(statement, options, found)
  found.sort((a, b) => a.at - b.at)
  const statics = found.filter((item) => item.isStatic)
  const rest = found.filter((item) => !item.isStatic)
  if (!isProgram || statics.length === 0) return found.map((item) => item.event)
  if (options.staticImports === 'first') {
    return [...statics, ...rest].map((item) => item.event)
  }
  // After the leading run of hoisted calls.
  let lead = 0
  while (lead < rest.length && rest[lead]?.isHoisted === true) lead++
  return [...rest.slice(0, lead), ...statics, ...rest.slice(lead)].map((item) => item.event)
}

function visit(node: Node, options: OrderOptions, out: BlockOrder[], depth: number): void {
  let inner = depth
  if (BLOCKS.has(node.type)) {
    // Pushed before descending, so the order is the order statement lists open (pre-order).
    const body = node.body
    const events = blockEvents(Array.isArray(body) ? body : [], options, node.type === 'Program')
    out.push({ depth, events })
    inner = depth + 1
  }
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item, options, out, inner)
    } else if (isNode(value)) {
      visit(value, options, out, inner)
    }
  }
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
  visit(program, options, out, 0)
  return out.filter((block) => block.events.length > 0)
}

/** One line per block, for a failure message. */
export function formatOrder(order: HoistOrder): string {
  if (order.length === 0) return '(no events)'
  return order
    .map((block, index) => `block ${index} (depth ${block.depth}): ${block.events.join(' > ')}`)
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
        block.events.length === other.events.length &&
        block.events.every((event, i) => event === other.events[i])
      )
    })
  )
}
