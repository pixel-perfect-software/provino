// `pnpm bench:loader graph` (T2.6, B13d): the node_modules graph's own bar. Track 2's spike scanned 877
// files, 8.1 MB and 3,199 edges in 83 ms cold; the spike is gone, so the corpus is rebuilt from the
// installed packages below, in this fixed order, until the reachable set holds at least those
// floors. The bar is the research's: cold at most 300 ms, warm at most 20 ms (`local`).
//
// Cold is a fresh process with no disk cache: the lexer's `init`, the scan, the resolution and one
// reverse query (`ansi-styles`' importers). Warm is the same process work with the cache file
// read and parsed instead of scanned. Both run in child processes, interleaved, and the bars are on
// the medians, and a warm run must reach the same files, edges and closure as a cold one. The edge
// check parses every file of the graph with `oxc-parser` and counts the static edges the graph
// misses (it may have extra ones: its `require` scan over-approximates), and the edges it left
// unresolved that Node's own resolution resolves (held to a ceiling).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildThirdPartyGraph,
  importersOf,
  initLexer,
  type ThirdPartyGraph,
} from '@provino/loader/graph'
import { createResolver } from '@provino/resolver'
import { lockfileHash } from '@provino/transform'
import { parseSync } from 'oxc-parser'

/** The installed packages the corpus starts from, in order; each is an exact store entry. */
export const CORPUS: readonly { readonly name: string; readonly version: string }[] = [
  { name: 'jsdom', version: '30.1.3' },
  { name: 'expect', version: '30.5.2' },
  { name: 'vite', version: '8.3.5' },
  { name: 'pretty-format', version: '30.5.1' },
  { name: 'tough-cookie', version: '6.0.2' },
  { name: 'magic-string', version: '1.4.5' },
]

/** The research's corpus: 877 files, 8.1 MB, 3,199 edges. */
export const FLOORS = { files: 877, bytes: 8_100_000, edges: 3_199 } as const

/**
 * The most edges the graph may leave unresolved (`target` of `null`) that Node's own resolution
 * resolves from the same file. Measured at 0 on the corpus: any edge here is a resolver difference.
 */
export const UNRESOLVED_CEILING = 0

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** The directory of an installed package in the pnpm store. */
function storeDir(name: string, version: string): string {
  const store = join(REPO_ROOT, 'node_modules/.pnpm')
  const prefix = `${name.replace('/', '+')}@${version}`
  const found = readdirSync(store).find((dir) => dir === prefix || dir.startsWith(`${prefix}_`))
  if (found === undefined) throw new Error(`${name}@${version} is not installed`)
  return join(store, found, 'node_modules', name)
}

/** A package's entry files: its `exports["."]` (every condition) and `main`, those that exist. */
function entryFiles(dir: string): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const targets: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') targets.push(value)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
  }
  if (manifest !== null && typeof manifest === 'object') {
    const exported = Reflect.get(manifest, 'exports')
    if (exported !== null && typeof exported === 'object' && '.' in exported) {
      collect(Reflect.get(exported, '.'))
    } else collect(exported)
    collect(Reflect.get(manifest, 'main'))
  }
  if (targets.length === 0) targets.push('index.js')
  return [...new Set(targets)]
    .filter((target) => /\.[cm]?js$/.test(target))
    .map((target) => join(dir, target))
    .filter((file) => existsSync(file))
}

/** The corpus's entry files, in order. */
export function corpusEntries(): string[] {
  return CORPUS.flatMap(({ name, version }) => entryFiles(storeDir(name, version)))
}

function resolverForCorpus() {
  return createResolver({
    root: REPO_ROOT,
    mappers: [],
    extensions: ['.js', '.mjs', '.cjs', '.json'],
    tsconfig: false,
  })
}

/**
 * What one process did: the milliseconds from before the lexer's `init` to after the query, and
 * what it reached. All numbers, so a child can print it as a sample line (`fromCache` is 0 or 1).
 */
export interface GraphRun {
  readonly ms: number
  readonly files: number
  readonly edges: number
  readonly importers: number
  /** The files the entries' closures hold, summed. */
  readonly closure: number
  readonly fromCache: number
  readonly scanned: number
}

export const GRAPH_RUN_KEYS: readonly (keyof GraphRun)[] = [
  'ms',
  'files',
  'edges',
  'importers',
  'closure',
  'fromCache',
  'scanned',
]

/**
 * One measured run in this process: start the lexer, build the graph from the corpus's entries
 * (reading `cacheDir` when it holds a graph, else scanning), and ask who imports `ansi-styles`.
 * With `save`, the scan is written to the cache after the timing.
 */
export async function measureGraph(cacheDir: string | null, save: boolean): Promise<GraphRun> {
  const entries = corpusEntries()
  const resolver = resolverForCorpus()
  const start = performance.now()
  await initLexer()
  const graph = buildThirdPartyGraph({
    root: REPO_ROOT,
    resolver,
    cacheDir,
    lockfileHash: lockfileHash(REPO_ROOT),
  })
  for (const entry of entries) graph.add(entry)
  const target = [...graph.paths()].find((path) =>
    /\/ansi-styles@[^/]+\/node_modules\/ansi-styles\/index\.js$/.test(path),
  )
  const importers = target === undefined ? 0 : importersOf(graph, target).length
  const ms = performance.now() - start
  // Not timed: what the entries reach, for the cold and warm runs to agree on.
  const closure = entries.reduce((sum, entry) => sum + graph.reachable(entry).length, 0)
  const run: GraphRun = {
    ms,
    files: graph.size,
    edges: graph.edgeCount,
    importers,
    closure,
    fromCache: graph.fromCache ? 1 : 0,
    scanned: graph.scanned,
  }
  if (save) graph.save()
  return run
}

/** The corpus's size: files, bytes on disk, edges. */
export interface CorpusStats {
  readonly files: number
  readonly bytes: number
  readonly edges: number
}

export function corpusStats(graph: ThirdPartyGraph): CorpusStats {
  let bytes = 0
  for (const path of graph.paths()) {
    try {
      bytes += statSync(path).size
    } catch {
      // A file that went away counts nothing.
    }
  }
  return { files: graph.size, bytes, edges: graph.edgeCount }
}

/** The corpus's graph, scanned in this process (for the stats and the edge check). */
export async function buildCorpusGraph(): Promise<ThirdPartyGraph> {
  await initLexer()
  const graph = buildThirdPartyGraph({ root: REPO_ROOT, resolver: resolverForCorpus() })
  for (const entry of corpusEntries()) graph.add(entry)
  return graph
}

/** The specifiers `oxc-parser` finds in a file: static imports and exports, `import('x')` and `require('x')`. */
function oxcSpecifiers(path: string, source: string): Set<string> | null {
  const found = new Set<string>()
  const result = parseSync(path, source, { sourceType: 'unambiguous' })
  // `parseSync` reports a syntax error in `errors` rather than throwing.
  if (result.errors.length > 0) return null
  for (const entry of result.module.staticImports) found.add(entry.moduleRequest.value)
  for (const entry of result.module.staticExports) {
    for (const item of entry.entries)
      if (item.moduleRequest !== null) found.add(item.moduleRequest.value)
  }
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const type = Reflect.get(node, 'type')
    if (type === 'CallExpression') {
      const callee = Reflect.get(node, 'callee')
      const [first] = Reflect.get(node, 'arguments') as unknown[]
      if (
        callee !== null &&
        typeof callee === 'object' &&
        Reflect.get(callee, 'type') === 'Identifier' &&
        Reflect.get(callee, 'name') === 'require' &&
        first !== null &&
        typeof first === 'object' &&
        Reflect.get(first, 'type') === 'Literal' &&
        typeof Reflect.get(first, 'value') === 'string'
      ) {
        found.add(Reflect.get(first, 'value') as string)
      }
    } else if (type === 'ImportExpression') {
      const argument = Reflect.get(node, 'source')
      if (
        argument !== null &&
        typeof argument === 'object' &&
        Reflect.get(argument, 'type') === 'Literal' &&
        typeof Reflect.get(argument, 'value') === 'string'
      ) {
        found.add(Reflect.get(argument, 'value') as string)
      }
    }
    for (const key of Object.keys(node)) visit(Reflect.get(node, key))
  }
  visit(result.program)
  return found
}

/** The edge check's result. */
export interface EdgeCheck {
  /** `file: specifier` for each static edge `oxc-parser` found that the graph lacks. */
  readonly missed: readonly string[]
  /** Edges the graph has that `oxc-parser` doesn't (the `require` scan counts comments and strings). */
  readonly extra: number
  readonly parseFailures: number
  /** `file: specifier` for each edge the graph left unresolved that Node resolves from the file. */
  readonly unresolved: readonly string[]
}

/** Whether Node's own resolution finds `specifier` from `path`. */
function nodeResolves(path: string, specifier: string): boolean {
  try {
    createRequire(path).resolve(specifier)
    return true
  } catch {
    return false
  }
}

/** Parses every file of the graph with `oxc-parser` and compares its edges with the graph's. */
export function checkEdges(graph: ThirdPartyGraph): EdgeCheck {
  const missed: string[] = []
  const unresolved: string[] = []
  let extra = 0
  let parseFailures = 0
  for (const path of graph.paths()) {
    if (!/\.[cm]?js$/.test(path)) continue
    const node = graph.nodeOf(path)
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    let expected: Set<string> | null
    try {
      expected = oxcSpecifiers(path, source)
    } catch {
      expected = null
    }
    if (expected === null) {
      parseFailures++
      continue
    }
    for (const edge of node?.edges ?? []) {
      if (edge.target === null && nodeResolves(path, edge.specifier)) {
        unresolved.push(`${path}: ${edge.specifier}`)
      }
    }
    const have = new Set((node?.edges ?? []).map((edge) => edge.specifier))
    for (const specifier of expected) if (!have.has(specifier)) missed.push(`${path}: ${specifier}`)
    for (const specifier of have) if (!expected.has(specifier)) extra++
  }
  return { missed, extra, parseFailures, unresolved }
}
