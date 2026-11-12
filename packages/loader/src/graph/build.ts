// The node_modules graph (T2.6, Track 2 R3): the import edges between the real files under
// `node_modules`, built lazily from the entries a caller adds, resolved with the worker's own
// resolver, and cached on disk by `cache.ts`. Only real paths under `node_modules` are nodes
// (B13d Gap 12): a workspace package linked into it resolves to its real path, so it is user code
// and a leaf here; `edgesOf` names the edges that lead to it, and the loader, which has its own
// record of a user module, follows them.
//
// A cached node is held as stored until a walk first visits it: then its file is stamped (one
// `stat`, a mismatch rescans it) and its edges are built. A file that could not be read, or an edge
// the resolver threw on, is `dynamic` (unknown to a closure walk) and never written to the cache.
import { readFileSync, statSync } from 'node:fs'
import type { Resolver } from '@provino/types'
import {
  type FileStamp,
  fromStored,
  type GraphEdge,
  type GraphNode,
  graphCacheFile,
  graphCacheKey,
  readGraphCache,
  type StoredNode,
  toStored,
  writeGraphCache,
} from './cache.ts'
import { conditionsOf } from './conditions.ts'
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
  /**
   * The hash of the project's lockfile (`lockfileHash` in `@provino/transform`, which the loader
   * takes from the transform cache), part of the cache key. `null` or absent: no disk cache.
   */
  readonly lockfileHash?: string | null
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
 * One edge of a closure, with the file that makes it.
 * @public
 */
export interface ClosureEdge {
  readonly importer: string
  readonly edge: GraphEdge
}

/**
 * The edges of a file's closure, each distinct request once (the first importer to make it).
 * @public
 */
export interface ClosureEdges {
  /** The files of the closure, the file itself first. */
  readonly paths: readonly string[]
  readonly edges: readonly ClosureEdge[]
  /** Some file in the closure has an edge the graph can't see, or could not be read. */
  readonly dynamic: boolean
}

/**
 * The graph of the files under `node_modules` that a set of entries reaches.
 * @public
 */
export interface ThirdPartyGraph {
  /**
   * Scans `entry` and every file under `node_modules` it can reach, unless already known. What a
   * cache file holds counts as known and is not stamped here: `reachable` and `edgesOf` do that, on
   * a file's first visit.
   */
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
  /**
   * The edges of `path`'s closure, deduplicated, computed once per worker. Adds `path` first if it
   * is a file under `node_modules` the graph doesn't know. Empty for any other path.
   */
  edgesOf(path: string): ClosureEdges
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
const NO_STAMP: FileStamp = { mtimeMs: 0, size: 0 }
const EMPTY: ClosureEdges = { paths: [], edges: [], dynamic: false }

/** Whether `path` is a real file under `node_modules` the graph covers. */
export function inGraph(path: string): boolean {
  return NODE_MODULES.test(path)
}

function scannable(path: string): boolean {
  return SCANNED.test(path) && !path.endsWith('.d.ts')
}

/** A file's place in the graph: held as stored until first visited, then as a node. */
interface Slot {
  node: GraphNode | null
  readonly stored: StoredNode | null
  readonly stamp: FileStamp
  /** The number of edges, known without building the node. */
  readonly edgeCount: number
  /** Whether its file was stamped in this worker (a scan here counts). */
  verified: boolean
}

interface Scanned {
  readonly node: GraphNode
  readonly stamp: FileStamp
  /** A read or a resolution failed: not worth keeping on disk. */
  readonly transient: boolean
}

/** What a closure walk keeps: the entries, and the deduplicated edges made once asked for. */
interface Closure {
  readonly entries: readonly GraphEntry[]
  edges: ClosureEdges | null
}

/**
 * Builds a graph, empty but for the cache file's nodes. Nothing is scanned until an entry is
 * added, and the lexer should be started first (`initLexer`).
 * @public
 */
export function buildThirdPartyGraph(options: GraphOptions): ThirdPartyGraph {
  const conditions = conditionsOf(options)
  const key =
    options.cacheDir == null
      ? null
      : graphCacheKey(
          options.root,
          `${options.resolver.fingerprint}\0${conditions.join(',')}`,
          options.lockfileHash ?? null,
        )
  const file =
    key === null || options.cacheDir == null ? null : graphCacheFile(options.cacheDir, key)
  const slots = new Map<string, Slot>()
  const fresh = new Map<string, Scanned>()
  const closures = new Map<string, Closure>()
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
    for (const [path, stored] of cached) {
      const slot: Slot = {
        node: null,
        stored,
        stamp: { mtimeMs: stored[2], size: stored[3] },
        edgeCount: stored[1].length,
        verified: false,
      }
      slots.set(path, slot)
      edgeCount += slot.edgeCount
    }
  }

  function scan(path: string): Scanned {
    let source = ''
    let stamp = NO_STAMP
    let transient = false
    if (scannable(path)) {
      try {
        // Stamped before it is read, so a write in between shows as a mismatch next time.
        const stats = statSync(path)
        stamp = { mtimeMs: stats.mtimeMs, size: stats.size }
        source = readFileSync(path, 'utf8')
      } catch {
        // Gone or unreadable: unknown, and tried again on a later run.
        transient = true
      }
    }
    const scanned = scanSource(source)
    const edges = scanned.edges.map(({ specifier, kind }): GraphEdge => {
      let target: string | null = null
      try {
        const result = options.resolver.resolve(specifier, { importer: path, kind, conditions })
        if (result.type === 'file') target = result.path
        else if (result.type === 'builtin') target = result.id
      } catch {
        // A resolver that throws (a custom one, or a file-system error) leaves the edge unknown.
        transient = true
      }
      return { specifier, kind, target }
    })
    return { node: { edges, dynamic: scanned.dynamic || transient }, stamp, transient }
  }

  /** Puts a scanned file in the graph in place of what was there. */
  function install(path: string, scanned: Scanned): Slot {
    const old = slots.get(path)
    if (old !== undefined) edgeCount -= old.edgeCount
    const slot: Slot = {
      node: scanned.node,
      stored: null,
      stamp: scanned.stamp,
      edgeCount: scanned.node.edges.length,
      verified: true,
    }
    slots.set(path, slot)
    edgeCount += slot.edgeCount
    scannedCount++
    if (scanned.transient) fresh.delete(path)
    else fresh.set(path, scanned)
    // Whatever closure held the old edges is not worth keeping.
    closures.clear()
    return slot
  }

  /** The node of a slot, built from its stored form on first use; a damaged one is rescanned. */
  function nodeOf(path: string, slot: Slot): GraphNode {
    if (slot.node !== null) return slot.node
    const node = slot.stored === null ? null : fromStored(slot.stored)
    if (node !== null) {
      slot.node = node
      return node
    }
    const scanned = scan(path)
    install(path, scanned)
    return scanned.node
  }

  /** The slot of `path` as a walk should see it: stamped on its first visit in this worker. */
  function visit(path: string, create: boolean): Slot | undefined {
    let slot = slots.get(path)
    if (slot === undefined) {
      if (!create || !inGraph(path)) return undefined
      return install(path, scan(path))
    }
    if (!slot.verified) {
      slot.verified = true
      if (scannable(path)) {
        let same = false
        try {
          const stats = statSync(path)
          same = stats.mtimeMs === slot.stamp.mtimeMs && stats.size === slot.stamp.size
        } catch {
          // Gone: rescanned, and unknown.
        }
        if (!same) slot = install(path, scan(path))
      }
    }
    return slot
  }

  function closureOf(start: string, create: boolean): Closure | undefined {
    const known = closures.get(start)
    if (known !== undefined) return known
    if (!create && !slots.has(start)) return undefined
    const seen = new Set<string>()
    const entries: GraphEntry[] = []
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined || seen.has(current)) continue
      seen.add(current)
      const slot = visit(current, true)
      if (slot === undefined) continue
      const node = nodeOf(current, slot)
      entries.push({ path: current, node })
      for (const edge of node.edges) {
        if (edge.target !== null && inGraph(edge.target)) stack.push(edge.target)
      }
    }
    // A closure that rescanned a file cleared the memo mid-walk: this one is whole now.
    const closure: Closure = { entries, edges: null }
    closures.set(start, closure)
    return closure
  }

  const graph: ThirdPartyGraph = {
    add(entry) {
      load()
      // What the cache holds is taken as whole: a walk (`reachable`, `edgesOf`) stamps it on first
      // visit and scans what a changed file now reaches. Only what is new is scanned here.
      const stack = [entry]
      while (stack.length > 0) {
        const path = stack.pop()
        if (path === undefined || !inGraph(path) || slots.has(path)) continue
        const scanned = scan(path)
        install(path, scanned)
        for (const edge of scanned.node.edges) {
          if (edge.target !== null && inGraph(edge.target) && !slots.has(edge.target)) {
            stack.push(edge.target)
          }
        }
      }
    },
    has: (path) => slots.has(path),
    nodeOf(path) {
      const slot = slots.get(path)
      return slot === undefined ? undefined : nodeOf(path, slot)
    },
    reachable: (path) => closureOf(path, false)?.entries ?? [],
    edgesOf(path) {
      load()
      if (!inGraph(path)) return EMPTY
      const closure = closureOf(path, true)
      if (closure === undefined) return EMPTY
      if (closure.edges === null) {
        const asked = new Set<string>()
        const edges: ClosureEdge[] = []
        let dynamic = false
        for (const { path: importer, node } of closure.entries) {
          if (node.dynamic) dynamic = true
          for (const edge of node.edges) {
            const request = `${edge.kind}\0${edge.target ?? ''}\0${edge.specifier}`
            if (asked.has(request)) continue
            asked.add(request)
            edges.push({ importer, edge })
          }
        }
        closure.edges = { paths: closure.entries.map((entry) => entry.path), edges, dynamic }
      }
      return closure.edges
    },
    paths: () => slots.keys(),
    get size() {
      return slots.size
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
      const stored = new Map<string, StoredNode>()
      for (const [path, scanned] of fresh) stored.set(path, toStored(scanned.node, scanned.stamp))
      writeGraphCache(file, key, stored)
      fresh.clear()
    },
  }
  return graph
}
