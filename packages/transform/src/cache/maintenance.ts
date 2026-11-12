// T3.6: what the coordinator does to the cache directory around a run. `prepareCache` wipes it when
// the lockfile changed (Vitest's rule: installed code moved, so every cached output may be stale
// for a reason no key sees). `pruneCache` evicts the oldest entries down to a size cap. Workers
// only read and write entries (`createTransformCache`).
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { WRITTEN_NAME, writeCacheTag } from './store.ts'

/** The file that holds the lockfile hash the directory was filled under. */
const STAMP_NAME = 'lockfile-hash'

/** Created after each `pruneCacheIfWritten`; with it and no `.written` sentinel, nothing was written since. */
const PRUNE_STAMP_NAME = 'pruned'

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
 * A hash of the nearest lockfile at or above `root`, or `null` when there is none. `memo`, which a
 * caller hashing several roots of one run shares, holds the hash of each lockfile by path, so a
 * lockfile several projects share is read once.
 * @public
 */
export function lockfileHash(root: string, memo?: Map<string, string>): string | null {
  let dir = root
  for (;;) {
    for (const name of LOCKFILES) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      const known = memo?.get(path)
      if (known !== undefined) return known
      try {
        const hash = createHash('sha256')
          .update(name)
          .update('\0')
          .update(readFileSync(path))
          .digest('hex')
        memo?.set(path, hash)
        return hash
      } catch {
        // Gone or unreadable since the check: as if it was never there.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** What `prepareCache` may be given in place of the file system's own calls (a test's failing `rm`). */
export interface PrepareCacheOptions {
  readonly rm?: (path: string, options: { recursive: true; force: true }) => void
}

/**
 * Makes `dir` ready for a run: when it was filled under another lockfile hash, everything in it is
 * removed (once more if the first try fails); then the directory, its `CACHEDIR.TAG` and the hash
 * stamp exist. A `null` hash (no lockfile) leaves the directory as it is. Never throws.
 *
 * Returns `false` when the directory is not safe to use: the stale entries could not be removed
 * (an interrupted or refused wipe), so the stamp is left as it was, for the next run to try again,
 * and the caller must run without this cache. `true` otherwise, including a directory that can't
 * be written to, which the workers' writes will skip.
 * @public
 */
export function prepareCache(
  dir: string,
  hash: string | null,
  options: PrepareCacheOptions = {},
): boolean {
  const remove = options.rm ?? rmSync
  try {
    let stamped: string | undefined
    try {
      stamped = readFileSync(join(dir, STAMP_NAME), 'utf8')
    } catch {
      stamped = undefined
    }
    if (hash !== null && stamped !== undefined && stamped !== hash) {
      // Twice: a first try that fails halfway often succeeds on the second.
      for (let attempt = 1; ; attempt++) {
        try {
          remove(dir, { recursive: true, force: true })
          break
        } catch {
          if (attempt === 2) return false
        }
      }
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
  return true
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

/**
 * `pruneCache`, unless no entry was written since the last time this ran: the first `set` of a
 * process leaves a `.written` sentinel in the directory, which this removes, so one `stat` replaces
 * reading every entry's size (directory timestamps can't say: on Linux a write in the same clock
 * tick leaves them unchanged). Returns `undefined` when it skipped. Never throws.
 * @public
 */
export function pruneCacheIfWritten(
  dir: string,
  maxBytes: number = DEFAULT_CACHE_MAX_BYTES,
): PruneResult | undefined {
  const stamp = join(dir, PRUNE_STAMP_NAME)
  // No stamp: never pruned, so prune. A stamp and no sentinel: nothing was written since.
  if (existsSync(stamp) && !existsSync(join(dir, WRITTEN_NAME))) return undefined
  // Removed before pruning, so a write during the prune leaves the next run one to find.
  rmSync(join(dir, WRITTEN_NAME), { force: true })
  const result = pruneCache(dir, maxBytes)
  try {
    closeSync(openSync(stamp, 'a'))
  } catch {
    // Without a stamp the next run prunes in full, as before.
  }
  return result
}
