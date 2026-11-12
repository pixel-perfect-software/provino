// T3.6: what the coordinator does to the cache directory around a run. `prepareCache` wipes it when
// the lockfile changed (Vitest's rule: installed code moved, so every cached output may be stale
// for a reason no key sees). `pruneCache` evicts the oldest entries down to a size cap. Workers
// only read and write entries (`createTransformCache`).
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { writeCacheTag } from './store.ts'

/** The file that holds the lockfile hash the directory was filled under. */
const STAMP_NAME = 'lockfile-hash'

/** A temporary file this much older than now is a writer that died. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000

/**
 * The default size cap of `pruneCache`: 512 MB (Track 3 R5).
 * @public
 */
export const DEFAULT_CACHE_MAX_BYTES: number = 512 * 1024 * 1024

const LOCKFILES: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]

/**
 * A hash of the nearest lockfile at or above `root`, or `null` when there is none.
 * @public
 */
export function lockfileHash(root: string): string | null {
  let dir = root
  for (;;) {
    for (const name of LOCKFILES) {
      try {
        const hash = createHash('sha256')
        hash
          .update(name)
          .update('\0')
          .update(readFileSync(join(dir, name)))
        return hash.digest('hex')
      } catch {
        // Not here.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Makes `dir` ready for a run: when it was filled under another lockfile hash, everything in it is
 * removed; then the directory, its `CACHEDIR.TAG` and the hash stamp exist. A `null` hash (no
 * lockfile) leaves the directory as it is. Best effort: it never throws, and a directory that can't
 * be written to is one the workers' writes will skip.
 * @public
 */
export function prepareCache(dir: string, hash: string | null): void {
  try {
    let stamped: string | undefined
    try {
      stamped = readFileSync(join(dir, STAMP_NAME), 'utf8')
    } catch {
      stamped = undefined
    }
    if (hash !== null && stamped !== undefined && stamped !== hash) {
      rmSync(dir, { recursive: true, force: true })
    }
    mkdirSync(dir, { recursive: true })
    writeCacheTag(dir)
    if (hash !== null && stamped !== hash) {
      const temporary = join(dir, `${STAMP_NAME}.${process.pid}.tmp`)
      writeFileSync(temporary, hash)
      renameSync(temporary, join(dir, STAMP_NAME))
    }
  } catch {
    // Best effort.
  }
}

/**
 * What `pruneCache` did.
 * @public
 */
export interface PruneResult {
  readonly removed: number
  readonly bytesBefore: number
  readonly bytesAfter: number
}

/**
 * Removes the oldest entries (by modification time) until the entries in `dir` fit `maxBytes`, and
 * any temporary file left by a writer that died. A hit does not touch its entry, so this evicts the
 * least recently written, not the least recently read. Never throws.
 * @public
 */
export function pruneCache(dir: string, maxBytes: number = DEFAULT_CACHE_MAX_BYTES): PruneResult {
  const entries: { path: string; size: number; mtimeMs: number }[] = []
  const now = Date.now()
  let bytes = 0
  try {
    for (const shard of readdirSync(dir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue
      const shardPath = join(dir, shard.name)
      for (const name of readdirSync(shardPath)) {
        const path = join(shardPath, name)
        try {
          const stat = statSync(path)
          if (name.endsWith('.tmp')) {
            if (now - stat.mtimeMs > STALE_TEMPORARY_MS) rmSync(path, { force: true })
            continue
          }
          entries.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
          bytes += stat.size
        } catch {
          // Removed while we looked.
        }
      }
    }
  } catch {
    return { removed: 0, bytesBefore: 0, bytesAfter: 0 }
  }
  const bytesBefore = bytes
  let removed = 0
  if (bytes > maxBytes) {
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of entries) {
      if (bytes <= maxBytes) break
      try {
        rmSync(entry.path, { force: true })
        bytes -= entry.size
        removed++
      } catch {
        // Keep going.
      }
    }
  }
  return { removed, bytesBefore, bytesAfter: bytes }
}
