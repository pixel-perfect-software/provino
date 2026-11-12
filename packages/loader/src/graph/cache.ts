// The graph's disk cache (T2.6, B13d Gap 10): `<dir>/graph/<key>.json`, keyed by what decides the
// contents of node_modules and how its edges resolve, with each node stamped by its file's mtime and
// size. Read once per worker and trusted by format and key, written once per worker, atomically and
// merged with the copy on disk, so a lost race between workers only costs a rescan.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { threadId } from 'node:worker_threads'
import type { EdgeKind } from './scan.ts'

/** The cache file's layout version: bumped when a node's shape or the scan's meaning changes. */
export const GRAPH_FORMAT = 2

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

/**
 * A node as the file holds it: `[dynamic, [specifier, kind, target][], mtimeMs, size]`. The two
 * numbers are the file's stamp when it was scanned, checked on the node's first visit in a worker.
 * @internal
 */
export type StoredNode = readonly [
  0 | 1,
  ReadonlyArray<readonly [string, 0 | 1, EdgeTarget]>,
  number,
  number,
]

/** What a file looked like when it was scanned. */
export interface FileStamp {
  readonly mtimeMs: number
  readonly size: number
}

interface CacheFile {
  readonly format: number
  readonly key: string
  readonly nodes: Readonly<Record<string, StoredNode>>
}

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

/** The size and mtime of the install marker nearest at or above `root` (empty when none). */
function installStamp(root: string): string {
  let dir = resolve(root)
  for (;;) {
    for (const marker of INSTALL_MARKERS) {
      try {
        const stats = statSync(join(dir, marker))
        return `${marker}:${stats.size}:${stats.mtimeMs}`
      } catch {
        // This marker isn't here: the other package manager's may be.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return ''
    dir = parent
  }
}

/**
 * The cache key: a hash of the lockfile's hash (`lockfileHash`, which the loader takes from the
 * transform cache's), the install marker's size and mtime, the graph format, the lexer's version
 * and how edges resolve (`extra`: the resolver's fingerprint and the conditions). `null` when the
 * project has no lockfile, and the graph then stays in memory.
 * @public
 */
export function graphCacheKey(
  root: string,
  extra: string,
  lockfileHash: string | null,
): string | null {
  if (lockfileHash === null) return null
  const hash = createHash('sha256')
  hash.update(String(GRAPH_FORMAT)).update('\0').update(lexerVersionOf()).update('\0')
  hash.update(resolve(root)).update('\0').update(extra).update('\0')
  hash.update(lockfileHash).update('\0').update(installStamp(root))
  return hash.digest('hex').slice(0, 32)
}

/** The cache file for a key under a cache directory. */
export function graphCacheFile(dir: string, key: string): string {
  return join(dir, 'graph', `${key}.json`)
}

/** A node as the graph holds it, or `null` for a stored form that is not one (a damaged file). */
export function fromStored(stored: StoredNode): GraphNode | null {
  try {
    return {
      dynamic: stored[0] === 1,
      edges: stored[1].map(([specifier, kind, target]) => ({
        specifier,
        kind: kind === 1 ? 'require' : 'import',
        target,
      })),
    }
  } catch {
    return null
  }
}

export function toStored(node: GraphNode, stamp: FileStamp): StoredNode {
  return [
    node.dynamic ? 1 : 0,
    node.edges.map((edge) => [edge.specifier, edge.kind === 'require' ? 1 : 0, edge.target]),
    stamp.mtimeMs,
    stamp.size,
  ]
}

/**
 * Reads a cache file: its nodes by path, in the stored form (a node is checked when it is first
 * visited), or `null` when it is missing, corrupt, or another format or key.
 */
export function readGraphCache(file: string, key: string): Map<string, StoredNode> | null {
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
  return new Map(Object.entries(stored as Record<string, StoredNode>))
}

/** Names a temp file apart from every other writer's: another process, or a worker thread of this one. */
const NONCE = `${process.pid}.${threadId}.${randomBytes(4).toString('hex')}`
let counter = 0

/**
 * Writes `nodes` merged over the copy on disk (in the stored form, with no conversion), through a
 * temp file and a rename, so a reader never sees half a file. A failure is swallowed, and its temp
 * file removed: the cache is only a speed-up.
 */
export function writeGraphCache(
  file: string,
  key: string,
  nodes: ReadonlyMap<string, StoredNode>,
): void {
  const temp = `${file}.${NONCE}.${counter++}.tmp`
  try {
    const merged = readGraphCache(file, key) ?? new Map<string, StoredNode>()
    for (const [path, node] of nodes) merged.set(path, node)
    const body: CacheFile = {
      format: GRAPH_FORMAT,
      key,
      nodes: Object.fromEntries(merged),
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, JSON.stringify(body))
    renameSync(temp, file)
  } catch {
    // Read-only checkout, a full disk: the graph is rebuilt next time.
    try {
      unlinkSync(temp)
    } catch {
      // Never written, or already gone.
    }
  }
}
