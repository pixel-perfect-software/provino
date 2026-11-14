// Babel, as jest-snapshot 30.5.2 loads it to write inline snapshots (`utils.ts` L172-L211): only
// when a snapshot is written, never by a run that writes none (D122). `@babel/core` and
// `@babel/generator` come from the project's own install when it has them, else from this
// package's pinned copies; the syntax plugins and preset are this package's, as jest-snapshot
// resolves them from itself.
//
// Babel ships no types of its own, so the few calls made here are typed by the shapes below: the
// module objects are read through `require` and checked for those functions before use.
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** A position in a Babel AST: 1-based line, 0-based column. */
export interface BabelPosition {
  line: number
  readonly column: number
}

/** The part of a Babel node this writer reads or changes. */
export interface BabelNode {
  readonly type: string
  readonly start?: number | null
  readonly end?: number | null
  readonly loc?: { readonly start: BabelPosition; readonly end: BabelPosition } | null
  // Read by the matcher-call checks; present on the node types that have them.
  readonly callee?: BabelNode
  readonly property?: BabelNode
  readonly computed?: boolean
  readonly name?: string
  arguments?: BabelNode[]
  readonly quasis?: readonly {
    readonly value: { raw: string }
    readonly start?: number | null
    readonly end?: number | null
  }[]
}

/** An ancestor as `types.traverse` hands it to its handler. */
interface Ancestor {
  readonly node: BabelNode
}

/** The parse options jest-snapshot gives `parseSync` (`utils.ts` L231-L262). */
export interface BabelParseOptions {
  readonly filename: string
  readonly plugins: readonly unknown[]
  readonly presets: readonly string[]
  readonly root: string
}

/** What this writer uses of `@babel/core` and `@babel/generator`. */
export interface Babel {
  parseSync(code: string, options: BabelParseOptions): BabelNode | null
  generate(node: BabelNode, options: { readonly retainLines: boolean }): { readonly code: string }
  traverseFast(node: BabelNode, enter: (node: BabelNode) => void): void
  traverse(node: BabelNode, enter: (node: BabelNode, ancestors: readonly Ancestor[]) => void): void
  isAwaitExpression(node: BabelNode): boolean
  templateLiteral(quasis: readonly unknown[], expressions: readonly unknown[]): BabelNode
  templateElement(value: { readonly raw: string }): unknown
  /** The paths of the preset and the two syntax plugins jest-snapshot passes. */
  readonly preset: string
  readonly typescriptPlugin: string
  readonly jsxPlugin: string
}

const own = createRequire(import.meta.url)

/** `name` from the project's root first, then from this package. */
function load(name: string, rootDir: string): unknown {
  let path: string
  try {
    path = createRequire(join(rootDir, 'package.json')).resolve(name)
  } catch {
    path = own.resolve(name)
  }
  return own(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

/** A function member, or an error that names the module that lacks it. */
function member<T>(module: unknown, key: string, name: string): T {
  const value = isRecord(module) ? module[key] : undefined
  if (typeof value !== 'function') {
    throw new TypeError(
      `${name} has no ${key}: it is not a Babel 7 the inline snapshot writer can use`,
    )
  }
  return value as T
}

const cache = new Map<string, Babel>()

/** Babel for a project, loaded once per root. */
export function babelFor(rootDir: string): Babel {
  const cached = cache.get(rootDir)
  if (cached !== undefined) return cached
  const core = load('@babel/core', rootDir)
  const generator = load('@babel/generator', rootDir)
  const types = isRecord(core) ? core.types : undefined
  const generate = isRecord(generator) && 'default' in generator ? generator.default : generator
  if (typeof generate !== 'function') {
    throw new TypeError('@babel/generator exports no function: it is not a Babel 7 generator')
  }
  const babel: Babel = {
    parseSync: member(core, 'parseSync', '@babel/core'),
    generate: generate as Babel['generate'],
    traverseFast: member(types, 'traverseFast', '@babel/core types'),
    traverse: member(types, 'traverse', '@babel/core types'),
    isAwaitExpression: member(types, 'isAwaitExpression', '@babel/core types'),
    templateLiteral: member(types, 'templateLiteral', '@babel/core types'),
    templateElement: member(types, 'templateElement', '@babel/core types'),
    preset: own.resolve('babel-preset-current-node-syntax'),
    typescriptPlugin: own.resolve('@babel/plugin-syntax-typescript'),
    jsxPlugin: own.resolve('@babel/plugin-syntax-jsx'),
  }
  cache.set(rootDir, babel)
  return babel
}
