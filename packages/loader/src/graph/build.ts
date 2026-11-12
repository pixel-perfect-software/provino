// The node_modules graph (T2.6, Track 2 R3): the import edges between the real files under
// `node_modules`, built lazily from the entries a caller adds, resolved with the worker's own
// resolver, and cached on disk by `cache.ts`. Only real paths under `node_modules` are nodes
// (B13d Gap 12): a workspace package linked into it resolves to its real path, so it is user code
// and a leaf here.
import { readFileSync } from 'node:fs'
import type { Resolver } from '@provino/types'
import {
  type GraphEdge,
  type GraphNode,
  graphCacheFile,
  graphCacheKey,
  readGraphCache,
  writeGraphCache,
} from './cache.ts'
import { scanSource } from './scan.ts'

/**
 * What `buildThirdPartyGraph` takes.
 * @public
 */
export interface GraphOptions {
  readonly root: string
  /** The worker's resolver: edges resolve as the loader resolves them. */
  readonly resolver: Resolver
  /** The resolution conditions the loader uses. Default `['node']`. */
  readonly conditions?: readonly string[]
  /**
   * The cache directory (the file is `<dir>/graph/<key>.json`). `null` or absent keeps the graph
   * in memory, as does a project with no lockfile.
   */
  readonly cacheDir?: string | null
}

/**
 * A file's place in the graph, with the files its edges lead to.
 * @public
 */
export interface GraphEntry {
  readonly path: string
  readonly node: GraphNode
}

/**
 * The graph of the files under `node_modules` that a set of entries reaches.
 * @public
 */
export interface ThirdPartyGraph {
  /** Scans `entry` and every file under `node_modules` it can reach, unless already known. */
  add(entry: string): void
  /** Whether `path` is in the graph. */
  has(path: string): boolean
  /** A file's edges, or `undefined` when it wasn't added or reached. */
  nodeOf(path: string): GraphNode | undefined
  /**
   * Every file `path` can reach, itself included, in discovery order (a cycle ends the walk).
   * Empty for a path that isn't in the graph.
   */
  reachable(path: string): readonly GraphEntry[]
  /** Every path in the graph. */
  paths(): IterableIterator<string>
  readonly size: number
  /** The number of edges, resolved or not. */
  readonly edgeCount: number
  /** How many files this graph scanned itself, rather than read from the cache. */
  readonly scanned: number
  /** Whether the graph began from a cache file. */
  readonly fromCache: boolean
  /** Writes what was scanned to the cache, if it is on and anything is new. */
  save(): void
}

const NODE_MODULES = /[\\/]node_modules[\\/]/
const SCANNED = /\.[cm]?[jt]sx?$/

/** Whether `path` is a real file under `node_modules` the graph covers. */
export function inGraph(path: string): boolean {
  return NODE_MODULES.test(path)
}

/**
 * Builds a graph, empty but for the cache file's nodes. Nothing is scanned until an entry is
 * added, and the lexer should be started first (`initLexer`) or scans run on its slower build.
 * @public
 */
export function buildThirdPartyGraph(options: GraphOptions): ThirdPartyGraph {
  const conditions = options.conditions ?? ['node']
  const key =
    options.cacheDir == null
      ? null
      : graphCacheKey(options.root, `${options.resolver.fingerprint}\0${conditions.join(',')}`)
  const file =
    key === null || options.cacheDir == null ? null : graphCacheFile(options.cacheDir, key)
  const nodes = new Map<string, GraphNode>()
  const fresh = new Map<string, GraphNode>()
  const closures = new Map<string, readonly GraphEntry[]>()
  let edgeCount = 0
  let scannedCount = 0
  let fromCache = false
  let loaded = false

  function load(): void {
    if (loaded) return
    loaded = true
    if (file === null || key === null) return
    const cached = readGraphCache(file, key)
    if (cached === null) return
    fromCache = true
    for (const [path, node] of cached) {
      nodes.set(path, node)
      edgeCount += node.edges.length
    }
  }

  function resolveEdges(path: string, scanned: ReturnType<typeof scanSource>): GraphEdge[] {
    return scanned.edges.map(({ specifier, kind }) => {
      let target: string | null = null
      try {
        const result = options.resolver.resolve(specifier, { importer: path, kind, conditions })
        if (result.type === 'file') target = result.path
        else if (result.type === 'builtin') target = result.id
      } catch {
        // A resolver that throws (a custom one) leaves the edge unresolved.
      }
      return { specifier, kind, target }
    })
  }

  function scan(path: string): GraphNode {
    let source = ''
    if (SCANNED.test(path) && !path.endsWith('.d.ts')) {
      try {
        source = readFileSync(path, 'utf8')
      } catch {
        // Gone or unreadable: a leaf.
      }
    }
    const scanned = scanSource(source)
    return { edges: resolveEdges(path, scanned), dynamic: scanned.dynamic }
  }

  const graph: ThirdPartyGraph = {
    add(entry) {
      load()
      const stack = [entry]
      while (stack.length > 0) {
        const path = stack.pop()
        if (path === undefined || !inGraph(path)) continue
        let node = nodes.get(path)
        if (node === undefined) {
          node = scan(path)
          nodes.set(path, node)
          fresh.set(path, node)
          scannedCount++
          edgeCount += node.edges.length
        }
        for (const edge of node.edges) {
          if (edge.target !== null && inGraph(edge.target) && !nodes.has(edge.target)) {
            stack.push(edge.target)
          }
        }
      }
    },
    has: (path) => nodes.has(path),
    nodeOf: (path) => nodes.get(path),
    reachable(path) {
      const cached = closures.get(path)
      if (cached !== undefined) return cached
      const seen = new Set<string>()
      const entries: GraphEntry[] = []
      const stack = [path]
      while (stack.length > 0) {
        const current = stack.pop()
        if (current === undefined || seen.has(current)) continue
        seen.add(current)
        const node = nodes.get(current)
        if (node === undefined) continue
        entries.push({ path: current, node })
        for (const edge of node.edges) {
          if (edge.target !== null && inGraph(edge.target)) stack.push(edge.target)
        }
      }
      // An entry not yet scanned has no closure to remember.
      if (nodes.has(path)) closures.set(path, entries)
      return entries
    },
    paths: () => nodes.keys(),
    get size() {
      return nodes.size
    },
    get edgeCount() {
      return edgeCount
    },
    get scanned() {
      return scannedCount
    },
    get fromCache() {
      return fromCache
    },
    save() {
      if (file === null || key === null || fresh.size === 0) return
      writeGraphCache(file, key, fresh)
      fresh.clear()
    },
  }
  return graph
}
