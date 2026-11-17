// B23e: V8 code cache packs, for the many small `vm.Script`s a loader compiles (one wrapper per
// module and mode: about 13,000 in a real React suite's first file). `createV8Cache` keeps a file
// per script, which costs an open, a stat, a read and a close per script: about 50 µs each here
// (`local`, macOS under the agent sandbox), 650 ms for 13,000. A pack is one file of many entries
// with an index at its head: a worker reads each pack's index once and then one entry per script
// with a positioned read (about 2.3 µs, `local`), and never holds the pack's data in memory.
//
// Layout: the packs live in `<dir>/v8/` (`dir` is the transform cache's directory, so its lockfile
// wipe and its size pruning cover them: `pruneCache` sees each pack as one entry), named
// `<tag>-<stamp>.pack` with `tag` = `v8CacheTag()` (V8's version, arch, platform and flags) and a
// stamp that sorts by time. A pack is
//
//   magic `PV8P`, u32 version, u32 entry count, u32 CRC-32 of the index   (16 bytes, LE)
//   index: per entry a 16-byte key, u32 offset, u32 length, u32 CRC-32    (28 bytes each)
//   data:  each entry's `Script.createCachedData()` bytes
//
// A writer never rewrites a pack: it adds a new one with what it compiled, and a newer pack's entry
// wins. `compactV8Packs`, which the coordinator runs after a run that wrote something, merges a
// tag's packs into one when there are many of them or their entries repeat (every worker of a cold
// run writes the same shared graph).
//
// The key is the code itself: a hash of the source, the filename and the offsets, so no caller can
// hand V8 an entry for another text (V8 checks only the source's length, and runs the old code for
// a same-length source). A checksum per entry is checked before V8 sees the data: V8 does not check
// the payload, and a flipped byte can abort the process (`cache.ts`). Everything is best effort, as
// in the transform cache: a pack that can't be read is a miss, one that can't be written is a
// count in `stats`, and a script always compiles.
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { Script } from 'node:vm'
import { crc32 } from 'node:zlib'
import { WRITTEN_NAME } from '../cache/store.ts'
import { v8CacheTag } from './cache.ts'
import type { CacheMode } from './mode.ts'

/** The subdirectory of the transform cache's directory the packs live in. */
const PACK_DIR = 'v8'
const MAGIC = 0x50385650 // `PV8P`, read as a little-endian u32
const VERSION = 1
const HEADER_BYTES = 16
const KEY_BYTES = 16
const INDEX_ENTRY_BYTES = KEY_BYTES + 12
/** A pack's data stays under this, so every offset fits a u32; a bigger write is several packs. */
const MAX_PACK_BYTES = 256 * 1024 * 1024
/** An index that claims more entries than this is not one. */
const MAX_ENTRIES = 4_000_000

/**
 * What a pack has done so far.
 * @public
 */
export interface V8PackStats {
  /** Scripts compiled from an entry V8 accepted. */
  readonly hits: number
  /** Scripts with no entry. */
  readonly misses: number
  /** Entries not given to V8 (a short read, a checksum that doesn't match) or refused by it; each script is queued again. */
  readonly rejected: number
  /** Scripts compiled with no lookup: shorter than `minLength`, or the pack is `'off'` or closed. */
  readonly skipped: number
  /** Packs whose index was read. */
  readonly packsRead: number
  /** Entries written. */
  readonly written: number
  /** Entries that could not be written: no data from V8, a directory that can't be made, a failed write or rename. */
  readonly writeFailures: number
}

/**
 * Options for `openV8Pack`.
 * @public
 */
export interface V8PackOptions {
  /** The transform cache's directory; the packs are in its `v8/` subdirectory, made on the first write. */
  readonly dir: string
  /** `'off'` makes `compile` a plain `new vm.Script` that reads and queues nothing. Default `'on'`. */
  readonly mode?: CacheMode
  /** Scripts shorter than this many characters compile with no lookup and are never written. Default 0. */
  readonly minLength?: number
}

/**
 * How a script is compiled: `vm.Script`'s `filename` and offsets.
 * @public
 */
export interface V8PackScriptOptions {
  readonly filename: string
  readonly lineOffset?: number
  readonly columnOffset?: number
}

/**
 * The V8 code cache of one worker's scripts, in packs.
 * @public
 */
export interface V8Pack {
  /**
   * Compiles `code` as a `vm.Script` with `options`, from the newest entry for exactly this code,
   * filename and offsets when V8 accepts it. A script with no entry, or whose entry was refused, is
   * queued for the next `write`, which serializes it then: after it has run, so the entry holds the
   * functions it compiled lazily. Reads every pack's index on its first call. Never throws because
   * of the cache, only for code that doesn't compile.
   */
  compile(code: string, options: V8PackScriptOptions): Script
  /** The scripts queued for the next `write`. */
  readonly pending: number
  /**
   * Serializes every queued script (`createCachedData`) and writes them as one new pack (or more,
   * over 256 MB), a temporary file and a rename each. Synchronous, so a worker that exits right
   * after leaves nothing half written. Never throws.
   */
  write(): void
  /** Closes the packs it read. Later compiles are plain ones; queued scripts are dropped. */
  close(): void
  /** A snapshot of the counters. */
  readonly stats: V8PackStats
}

/** Where an entry is: an open pack, an offset, a length and the data's checksum. */
interface Located {
  readonly fd: number
  readonly offset: number
  readonly length: number
  readonly crc: number
}

/**
 * One entry to write: its key (16 bytes, as hex) and V8's data.
 * @internal
 */
export interface V8PackEntry {
  readonly key: string
  readonly data: Buffer
}

/**
 * The key of a script: the first 16 bytes of the sha256 of its filename, offsets and code, as hex.
 * @internal
 */
export function v8PackKey(code: string, options: V8PackScriptOptions): string {
  return createHash('sha256')
    .update(`${options.filename}\0${options.lineOffset ?? 0}\0${options.columnOffset ?? 0}\0`)
    .update(code)
    .digest('hex')
    .slice(0, KEY_BYTES * 2)
}

/** A pack's file name: the tag, then a stamp that sorts by time (then by writer). */
const PACK_NAME = /^([0-9a-f]{16})-[0-9a-z-]+\.pack$/

/** The packs of `tag` in `dir`, oldest first; none when the directory can't be read. */
function packsOf(dir: string, tag: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => PACK_NAME.exec(name)?.[1] === tag)
      .sort()
  } catch {
    return []
  }
}

/** The index of the pack open at `fd`, or `null` when it is not a whole pack of this version. */
function readIndex(fd: number): { readonly keys: Buffer; readonly count: number } | null {
  const size = fstatSync(fd).size
  if (size < HEADER_BYTES) return null
  const header = Buffer.allocUnsafe(HEADER_BYTES)
  if (readSync(fd, header, 0, HEADER_BYTES, 0) !== HEADER_BYTES) return null
  if (header.readUInt32LE(0) !== MAGIC || header.readUInt32LE(4) !== VERSION) return null
  const count = header.readUInt32LE(8)
  const indexBytes = count * INDEX_ENTRY_BYTES
  if (count > MAX_ENTRIES || HEADER_BYTES + indexBytes > size) return null
  const index = Buffer.allocUnsafe(indexBytes)
  if (readSync(fd, index, 0, indexBytes, HEADER_BYTES) !== indexBytes) return null
  if (crc32(index) !== header.readUInt32LE(12)) return null
  for (let at = 0; at < indexBytes; at += INDEX_ENTRY_BYTES) {
    const offset = index.readUInt32LE(at + KEY_BYTES)
    const length = index.readUInt32LE(at + KEY_BYTES + 4)
    if (length === 0 || offset < HEADER_BYTES + indexBytes || offset + length > size) return null
  }
  return { keys: index, count }
}

/** Every entry of the pack at `fd` into `into`, by key (a later call's entry replaces an earlier one). */
function indexInto(fd: number, into: Map<string, Located>): boolean {
  const index = readIndex(fd)
  if (index === null) return false
  for (let at = 0; at < index.count * INDEX_ENTRY_BYTES; at += INDEX_ENTRY_BYTES) {
    into.set(index.keys.toString('hex', at, at + KEY_BYTES), {
      fd,
      offset: index.keys.readUInt32LE(at + KEY_BYTES),
      length: index.keys.readUInt32LE(at + KEY_BYTES + 4),
      crc: index.keys.readUInt32LE(at + KEY_BYTES + 8),
    })
  }
  return true
}

/** An entry's data, or `undefined` when it can't be read whole or its checksum doesn't match. */
function readEntry(found: Located): Buffer | undefined {
  try {
    const data = Buffer.allocUnsafe(found.length)
    if (readSync(found.fd, data, 0, found.length, found.offset) !== found.length) return undefined
    return crc32(data) === found.crc ? data : undefined
  } catch {
    return undefined
  }
}

/**
 * `entries` as one pack's bytes (keys as 32 hex characters).
 * @internal
 */
export function encodeV8Pack(entries: readonly V8PackEntry[]): Buffer {
  const indexBytes = entries.length * INDEX_ENTRY_BYTES
  const index = Buffer.allocUnsafe(indexBytes)
  let offset = HEADER_BYTES + indexBytes
  entries.forEach((entry, i) => {
    const at = i * INDEX_ENTRY_BYTES
    index.write(entry.key, at, KEY_BYTES, 'hex')
    index.writeUInt32LE(offset, at + KEY_BYTES)
    index.writeUInt32LE(entry.data.length, at + KEY_BYTES + 4)
    index.writeUInt32LE(crc32(entry.data), at + KEY_BYTES + 8)
    offset += entry.data.length
  })
  const header = Buffer.allocUnsafe(HEADER_BYTES)
  header.writeUInt32LE(MAGIC, 0)
  header.writeUInt32LE(VERSION, 4)
  header.writeUInt32LE(entries.length, 8)
  header.writeUInt32LE(crc32(index), 12)
  return Buffer.concat([header, index, ...entries.map((entry) => entry.data)])
}

/** `entries` in runs whose data stays under `MAX_PACK_BYTES`. */
function inPacks(entries: readonly V8PackEntry[]): V8PackEntry[][] {
  const packs: V8PackEntry[][] = []
  let current: V8PackEntry[] = []
  let bytes = 0
  for (const entry of entries) {
    if (current.length > 0 && bytes + entry.data.length > MAX_PACK_BYTES) {
      packs.push(current)
      current = []
      bytes = 0
    }
    current.push(entry)
    bytes += entry.data.length
  }
  if (current.length > 0) packs.push(current)
  return packs
}

/** Who writes packs: an id distinct per process and per pack or compaction, and a count of its packs. */
interface Writer {
  readonly id: string
  packs: number
}

function newWriter(): Writer {
  return { id: `${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`, packs: 0 }
}

/**
 * Writes `entries` as new packs of `tag` in `dir`, each a temporary file and a rename, named so they
 * sort after every pack written before them (by time, then by writer and count). Returns how many
 * entries and packs were written; a pack that fails is dropped whole, its temporary file removed.
 */
function writePacks(
  dir: string,
  tag: string,
  writer: Writer,
  entries: readonly V8PackEntry[],
): { readonly entries: number; readonly packs: number } {
  let written = 0
  let packs = 0
  let made = false
  for (const pack of inPacks(entries)) {
    const stamp = Date.now().toString(36).padStart(9, '0')
    const file = join(dir, `${tag}-${stamp}-${writer.id}-${(writer.packs++).toString(36)}.pack`)
    const temporary = `${file}.tmp`
    try {
      if (!made) {
        mkdirSync(dir, { recursive: true })
        made = true
      }
      writeFileSync(temporary, encodeV8Pack(pack))
      renameSync(temporary, file)
      written += pack.length
      packs++
    } catch {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // No directory to remove it from (ENOTDIR), or no right to: nothing was left there.
      }
    }
  }
  return { entries: written, packs }
}

/**
 * Opens the V8 code cache packs under `options.dir` (the transform cache's directory). Nothing is
 * read before the first `compile` and nothing is created before the first `write`.
 * @public
 */
export function openV8Pack(options: V8PackOptions): V8Pack {
  const root = resolve(options.dir)
  const dir = join(root, PACK_DIR)
  const minLength = options.minLength ?? 0
  let on = (options.mode ?? 'on') === 'on'
  const counts = {
    hits: 0,
    misses: 0,
    rejected: 0,
    skipped: 0,
    packsRead: 0,
    written: 0,
    writeFailures: 0,
  }
  const queue = new Map<string, Script>()
  const fds: number[] = []
  let entries: Map<string, Located> | undefined
  let tag: string | undefined
  let marked = false
  const writer = newWriter()

  function index(): Map<string, Located> {
    if (entries !== undefined) return entries
    entries = new Map()
    tag ??= v8CacheTag()
    for (const name of packsOf(dir, tag)) {
      let fd: number
      try {
        fd = openSync(join(dir, name), 'r')
      } catch {
        continue
      }
      let read = false
      try {
        read = indexInto(fd, entries)
      } catch {
        read = false
      }
      if (read) {
        fds.push(fd)
        counts.packsRead++
      } else {
        closeSync(fd)
      }
    }
    return entries
  }

  return {
    compile(code, scriptOptions) {
      const compileOptions = {
        filename: scriptOptions.filename,
        lineOffset: scriptOptions.lineOffset ?? 0,
        columnOffset: scriptOptions.columnOffset ?? 0,
      }
      if (!on || code.length < minLength) {
        counts.skipped++
        return new Script(code, compileOptions)
      }
      const key = v8PackKey(code, scriptOptions)
      const found = index().get(key)
      const data = found === undefined ? undefined : readEntry(found)
      const script =
        data === undefined
          ? new Script(code, compileOptions)
          : new Script(code, { ...compileOptions, cachedData: data })
      if (found === undefined) {
        counts.misses++
      } else if (data === undefined || script.cachedDataRejected === true) {
        counts.rejected++
      } else {
        counts.hits++
        return script
      }
      queue.set(key, script)
      return script
    },
    get pending() {
      return queue.size
    },
    write() {
      if (queue.size === 0) return
      const made: V8PackEntry[] = []
      for (const [key, script] of queue) {
        try {
          const data = script.createCachedData()
          if (data.length > 0) made.push({ key, data })
          else counts.writeFailures++
        } catch {
          counts.writeFailures++
        }
      }
      queue.clear()
      if (made.length === 0) return
      tag ??= v8CacheTag()
      const written = writePacks(dir, tag, writer, made).entries
      counts.written += written
      counts.writeFailures += made.length - written
      // The transform cache's sentinel: the coordinator prunes and compacts after a run that wrote.
      if (written > 0 && !marked) {
        marked = true
        try {
          writeFileSync(join(root, WRITTEN_NAME), '')
        } catch {
          // The next write of the transform cache leaves it, or the next prune reads every entry.
        }
      }
    },
    close() {
      on = false
      queue.clear()
      for (const fd of fds.splice(0)) {
        try {
          closeSync(fd)
        } catch {
          // Already closed.
        }
      }
      entries = new Map()
    },
    get stats() {
      return { ...counts }
    },
  }
}

/**
 * What `compactV8Packs` did.
 * @public
 */
export interface V8PackCompaction {
  /** Packs read and replaced by merged ones. */
  readonly merged: number
  /** Packs it wrote. */
  readonly written: number
  /** Packs it found, of every tag. */
  readonly packs: number
}

/**
 * Options for `compactV8Packs`.
 * @public
 */
export interface V8PackCompactionOptions {
  /** A tag with more packs than this is merged. Default 8. */
  readonly maxPacks?: number
  /** A tag whose entries repeat by more than this share of their bytes is merged. Default 0.25. */
  readonly repeatedShare?: number
}

/**
 * Merges the packs of each tag in `<dir>/v8` into one (or more, over 256 MB) when there are more
 * than `maxPacks` of them or more than `repeatedShare` of their bytes are entries another pack also
 * holds: the newest entry of each key is kept, and an entry whose checksum fails is dropped. The
 * merged packs are written first (a temporary file and a rename each), then the packs they replace
 * are removed; a pack another process is reading stays readable to it (POSIX), and one written
 * meanwhile is left for the next compaction. The coordinator's, after a run (`pruneCacheIfWritten`).
 * Never throws.
 * @public
 */
export function compactV8Packs(
  dir: string,
  options: V8PackCompactionOptions = {},
): V8PackCompaction {
  const maxPacks = options.maxPacks ?? 8
  const repeatedShare = options.repeatedShare ?? 0.25
  const packDir = join(resolve(dir), PACK_DIR)
  let names: string[]
  try {
    names = readdirSync(packDir)
  } catch {
    return { merged: 0, written: 0, packs: 0 }
  }
  const byTag = new Map<string, string[]>()
  for (const name of names) {
    const tag = PACK_NAME.exec(name)?.[1]
    if (tag === undefined) continue
    const list = byTag.get(tag) ?? []
    list.push(name)
    byTag.set(tag, list)
  }
  let merged = 0
  let written = 0
  let packs = 0
  const writer = newWriter()
  for (const [tag, list] of byTag) {
    packs += list.length
    if (list.length < 2) continue
    list.sort()
    const newest = new Map<string, Located>()
    const fds: number[] = []
    const readable: string[] = []
    let totalBytes = 0
    try {
      for (const name of list) {
        let fd: number
        try {
          fd = openSync(join(packDir, name), 'r')
        } catch {
          continue
        }
        fds.push(fd)
        const before = new Map<string, Located>()
        try {
          if (!indexInto(fd, before)) {
            // Not a pack this version reads: it goes with the merge, its entries with it.
            readable.push(name)
            continue
          }
        } catch {
          continue
        }
        readable.push(name)
        for (const [key, found] of before) {
          totalBytes += found.length
          newest.set(key, found)
        }
      }
      let keptBytes = 0
      for (const found of newest.values()) keptBytes += found.length
      const repeated = totalBytes === 0 ? 0 : (totalBytes - keptBytes) / totalBytes
      if (readable.length < 2 || (readable.length <= maxPacks && repeated <= repeatedShare)) {
        continue
      }
      const kept: V8PackEntry[] = []
      for (const [key, found] of newest) {
        const data = readEntry(found)
        if (data !== undefined) kept.push({ key, data })
      }
      const wrote = writePacks(packDir, tag, writer, kept)
      // A merge that lost a pack keeps the packs it read: nothing is removed it didn't replace.
      if (wrote.entries !== kept.length) continue
      written += wrote.packs
      for (const name of readable) {
        try {
          rmSync(join(packDir, name), { force: true })
          merged++
        } catch {
          // Removed by another compaction, or not ours to remove: the next one tries again.
        }
      }
    } finally {
      for (const fd of fds) {
        try {
          closeSync(fd)
        } catch {
          // Already closed.
        }
      }
    }
  }
  return { merged, written, packs }
}
