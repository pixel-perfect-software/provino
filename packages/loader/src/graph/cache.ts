// The graph's disk cache (T2.6, B13d Gap 10): `<dir>/graph/<key>.json`, keyed by what decides the
// contents of node_modules and how its edges resolve. Read once per worker, written atomically
// and merged with the copy on disk, so a lost race between workers only costs a rescan.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EdgeKind } from './scan.ts'

/** The cache file's layout version: bumped when a node's shape or the scan's meaning changes. */
export const GRAPH_FORMAT = 1

/**
 * A target of an edge: a real path, a `node:` builtin, or `null` for one that doesn't resolve.
 * @public
 */
export type EdgeTarget = string | null

/**
 * One resolved edge.
 * @public
 */
export interface GraphEdge {
  readonly specifier: string
  readonly kind: EdgeKind
  readonly target: EdgeTarget
}

/**
 * One scanned file: its edges, and whether it has a specifier the scan couldn't read.
 * @public
 */
export interface GraphNode {
  readonly edges: readonly GraphEdge[]
  readonly dynamic: boolean
}

/** A node as the file holds it: `[dynamic, [specifier, kind, target][]]`. */
type StoredNode = readonly [0 | 1, ReadonlyArray<readonly [string, 0 | 1, EdgeTarget]>]

interface CacheFile {
  readonly format: number
  readonly key: string
  readonly nodes: Readonly<Record<string, StoredNode>>
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
const INSTALL_MARKERS = ['node_modules/.modules.yaml', 'node_modules/.package-lock.json']

let lexerVersion: string | undefined

/** The installed lexer's version, which decides what a scan finds. */
function lexerVersionOf(): string {
  if (lexerVersion !== undefined) return lexerVersion
  try {
    const entry = fileURLToPath(import.meta.resolve('es-module-lexer'))
    const manifest: unknown = JSON.parse(
      readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'),
    )
    const version =
      manifest !== null && typeof manifest === 'object' ? Reflect.get(manifest, 'version') : null
    lexerVersion = typeof version === 'string' ? version : 'unknown'
  } catch {
    lexerVersion = 'unknown'
  }
  return lexerVersion
}

/** The nearest lockfile at or above `root`, with its directory. */
function findLockfile(root: string): { readonly dir: string; readonly file: string } | null {
  let dir = resolve(root)
  for (;;) {
    for (const name of LOCKFILES) {
      const file = join(dir, name)
      if (existsSync(file)) return { dir, file }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The cache key: a hash of the nearest lockfile, the install marker's size and mtime, the graph
 * format, the lexer's version and how edges resolve (`extra`: the resolver's fingerprint and the
 * conditions). `null` when the project has no lockfile, and the graph then stays in memory.
 * @public
 */
export function graphCacheKey(root: string, extra: string): string | null {
  const lock = findLockfile(root)
  if (lock === null) return null
  const hash = createHash('sha256')
  hash.update(String(GRAPH_FORMAT)).update('\0').update(lexerVersionOf()).update('\0')
  hash.update(resolve(root)).update('\0').update(extra).update('\0')
  hash.update(readFileSync(lock.file))
  for (const marker of INSTALL_MARKERS) {
    try {
      const stats = statSync(join(lock.dir, marker))
      hash.update(`\0${marker}:${stats.size}:${stats.mtimeMs}`)
    } catch {
      // This marker isn't there: the other package manager's may be.
    }
  }
  return hash.digest('hex').slice(0, 32)
}

/** The cache file for a key under a cache directory. */
export function graphCacheFile(dir: string, key: string): string {
  return join(dir, 'graph', `${key}.json`)
}

function fromStored(stored: StoredNode): GraphNode {
  return {
    dynamic: stored[0] === 1,
    edges: stored[1].map(([specifier, kind, target]) => ({
      specifier,
      kind: kind === 1 ? 'require' : 'import',
      target,
    })),
  }
}

function toStored(node: GraphNode): StoredNode {
  return [
    node.dynamic ? 1 : 0,
    node.edges.map((edge) => [edge.specifier, edge.kind === 'require' ? 1 : 0, edge.target]),
  ]
}

function isStoredNode(value: unknown): value is StoredNode {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (value[0] === 0 || value[0] === 1) &&
    Array.isArray(value[1]) &&
    value[1].every(
      (edge: unknown) =>
        Array.isArray(edge) &&
        edge.length === 3 &&
        typeof edge[0] === 'string' &&
        (edge[1] === 0 || edge[1] === 1) &&
        (edge[2] === null || typeof edge[2] === 'string'),
    )
  )
}

/**
 * Reads a cache file: its nodes by path, or `null` when it is missing, corrupt, or another
 * format or key (a corrupt file is rebuilt by the next write).
 */
export function readGraphCache(file: string, key: string): Map<string, GraphNode> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  if (Reflect.get(parsed, 'format') !== GRAPH_FORMAT || Reflect.get(parsed, 'key') !== key) {
    return null
  }
  const stored: unknown = Reflect.get(parsed, 'nodes')
  if (stored === null || typeof stored !== 'object') return null
  const nodes = new Map<string, GraphNode>()
  for (const [path, value] of Object.entries(stored)) {
    if (!isStoredNode(value)) return null
    nodes.set(path, fromStored(value))
  }
  return nodes
}

/**
 * Writes `nodes` merged over the copy on disk, through a temp file and a rename, so a reader
 * never sees half a file. A failure is swallowed: the cache is only a speed-up.
 */
export function writeGraphCache(
  file: string,
  key: string,
  nodes: ReadonlyMap<string, GraphNode>,
): void {
  try {
    const merged = readGraphCache(file, key) ?? new Map<string, GraphNode>()
    for (const [path, node] of nodes) merged.set(path, node)
    const body: CacheFile = {
      format: GRAPH_FORMAT,
      key,
      nodes: Object.fromEntries([...merged].map(([path, node]) => [path, toStored(node)])),
    }
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, JSON.stringify(body))
    renameSync(temp, file)
  } catch {
    // Read-only checkout, a full disk: the graph is rebuilt next time.
  }
}
