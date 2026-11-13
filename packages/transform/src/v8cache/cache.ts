// T3.7: V8 code cache for the `vm.Script`s a vm-based loader compiles. Node's
// `module.enableCompileCache` covers the modules Node compiles itself and not `vm.Script`, so the
// loader has to manage V8's `cachedData` on its own (Track 3 R6/F7: a 9.1 MB module is 130 ms to
// compile in a fresh process and 20 ms with `cachedData`, 6.8x, `local`).
//
// One file per script at `<dir>/<v8CacheTag()>/<key[0..2]>/<key>`: the CRC-32 of the data as 4
// bytes (little endian), then what `Script.createCachedData()` returned. Everything is best effort,
// as the transform cache is: a directory that can't be read or written is a cache that misses, and
// the script always compiles.
//
// What V8 checks of an entry, and what it doesn't (measured on Node 24, `local`): its version and
// flags hash (the tag directory keeps another build's entries from being read at all), the length
// of the source, and the data's own length and header. A truncated, empty or garbage entry is
// rejected; **a source of the same length is not**, and V8 then runs the old code. So `key` must
// identify the code exactly. **Nor is the payload checked**: a byte flipped in place (a disk error,
// a tool that touched the file) is accepted, or aborts the process ("unreachable code", SIGTRAP),
// and the next run reads the same file and dies the same way. Node's own compile cache keeps a
// CRC-32 for the same reason, and so does an entry here: one that doesn't match its data is
// rejected, compiled normally and rewritten, and V8 never sees it. And V8 keeps a compilation
// cache of its own per isolate: a source
// compiled earlier in this process is served from it, `cachedData` is ignored, and
// `cachedDataRejected` is `false` whatever the entry holds. A bad entry is therefore always seen
// by the next process, never by the one that compiled the same text first.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { cachedDataVersionTag } from 'node:v8'
import { Script } from 'node:vm'
import { crc32 } from 'node:zlib'
import { writeCacheTag } from '../cache/store.ts'
import { V8CacheError } from './errors.ts'
import type { CacheMode } from './mode.ts'

/**
 * What a cache has done so far, in loads and writes.
 * @public
 */
export interface V8CacheStats {
  /** Entries read and accepted by V8. */
  readonly hits: number
  /** Loads with no entry on disk. */
  readonly misses: number
  /** Entries not given to V8 or refused by it (and scheduled to be replaced): empty, truncated, garbage, a checksum that doesn't match, or from another V8. */
  readonly rejected: number
  /** Entries written (a miss's, and a rejected entry's replacement). */
  readonly written: number
  /** Writes that failed: a directory that can't be created or written, a failed rename. */
  readonly writeFailures: number
}

/**
 * Options for `createV8Cache`.
 * @public
 */
export interface V8CacheOptions {
  /** The directory the entries live under (`<dir>/<tag>/<2 hex>/<key>`). Created on the first write. */
  readonly dir: string
  /** `'off'` makes `loadScript` a plain `new vm.Script` that touches nothing. Default `'on'`. */
  readonly mode?: CacheMode
}

/**
 * A directory of V8 code-cache entries.
 * @public
 */
export interface V8Cache {
  /**
   * Compiles `code` as a `vm.Script` named `filename`, with the entry stored under `key` when
   * there is one V8 accepts. `key` must identify `code` exactly (the caller passes the transform
   * record's cache key: the hash of the runner form), since V8 only compares lengths. A miss, or
   * an entry V8 rejects, schedules a background write after the current turn, so the entry holds
   * the functions the script's top level has run by then; `flush` awaits it. Never throws
   * because of the cache: only for a `key` that is not a plain token (`V8_CACHE_KEY_INVALID`) or
   * for code that doesn't compile. In mode `'off'` it is `new vm.Script(code, { filename })`: no
   * read, no write, and `stats` doesn't move (a pass-through is not a miss).
   */
  loadScript(code: string, filename: string, key: string): Script
  /** Resolves once every background write started so far has finished, or failed. */
  flush(): Promise<void>
  /** A snapshot of the counters. */
  readonly stats: V8CacheStats
}

/**
 * The V8 side of every entry's path: the first 16 hex characters of the sha1 of
 * `process.versions.v8`, `process.arch`, `process.platform` and `v8.cachedDataVersionTag()` (which
 * already covers V8's flags). A different V8 build, platform or flag set reads another directory,
 * so a stale entry is never offered to V8.
 * @public
 */
export function v8CacheTag(): string {
  return createHash('sha1')
    .update(
      [process.versions.v8, process.arch, process.platform, String(cachedDataVersionTag())].join(
        '\0',
      ),
    )
    .digest('hex')
    .slice(0, 16)
}

/** The bytes in front of V8's data: its CRC-32, little endian. */
const CHECKSUM_BYTES = 4

/** `data` with its checksum in front, as an entry is stored. */
function sealed(data: Buffer): Buffer {
  const entry = Buffer.allocUnsafe(CHECKSUM_BYTES + data.length)
  entry.writeUInt32LE(crc32(data), 0)
  data.copy(entry, CHECKSUM_BYTES)
  return entry
}

/** The data inside `entry`, or `undefined` when its checksum is missing or doesn't match it. */
function opened(entry: Buffer): Buffer | undefined {
  if (entry.length <= CHECKSUM_BYTES) return undefined
  const data = entry.subarray(CHECKSUM_BYTES)
  return crc32(data) === entry.readUInt32LE(0) ? data : undefined
}

/** Keys are hashes; anything with a separator, a dot or a NUL is a caller's bug. */
const KEY = /^[0-9A-Za-z_-]{2,128}$/

function checkKey(key: string): void {
  if (!KEY.test(key)) {
    throw new V8CacheError(
      'V8_CACHE_KEY_INVALID',
      `A V8 cache key is 2 to 128 letters, digits, "_" or "-" (a hash), got ${JSON.stringify(key)}`,
    )
  }
}

/**
 * Opens the V8 code cache in `options.dir`. Nothing is created until the first write.
 * @public
 */
export function createV8Cache(options: V8CacheOptions): V8Cache {
  const mode = options.mode ?? 'on'
  const root = resolve(options.dir)
  const counts = { hits: 0, misses: 0, rejected: 0, written: 0, writeFailures: 0 }
  // The writes in flight by entry path: a script loaded again before its write has run (a second
  // test file in the same worker) does not queue another one.
  const inFlight = new Map<string, Promise<void>>()
  let tagDir: string | undefined
  let tagged = false
  let counter = 0
  // Distinct per process and per cache object, so two writers never share a temporary name.
  const nonce = `${process.pid}.${randomBytes(4).toString('hex')}`

  function entryPath(key: string): string {
    tagDir ??= join(root, v8CacheTag())
    return join(tagDir, key.slice(0, 2), key)
  }

  async function write(file: string, script: Script): Promise<void> {
    // After the caller's turn, so the data holds the functions the top level has run.
    await new Promise<void>((done) => setImmediate(done))
    try {
      const data = script.createCachedData()
      if (data.length === 0) throw new Error('V8 produced no cached data')
      await mkdir(dirname(file), { recursive: true })
      if (!tagged) {
        tagged = true
        writeCacheTag(root)
      }
      const temp = `${file}.${nonce}.${counter++}.tmp`
      try {
        await writeFile(temp, sealed(data))
        await rename(temp, file)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
      counts.written++
    } catch {
      counts.writeFailures++
    }
  }

  function schedule(file: string, script: Script): void {
    if (inFlight.has(file)) return
    const task = write(file, script).finally(() => inFlight.delete(file))
    inFlight.set(file, task)
  }

  return {
    loadScript(code, filename, key) {
      checkKey(key)
      if (mode === 'off') return new Script(code, { filename })
      const file = entryPath(key)
      let entry: Buffer | undefined
      try {
        entry = readFileSync(file)
      } catch {
        entry = undefined
      }
      if (entry === undefined) {
        const script = new Script(code, { filename })
        counts.misses++
        schedule(file, script)
        return script
      }
      // An empty, torn or flipped file never reaches V8: it would reject some of them, only when
      // it has not seen this source before in the process, and abort or accept others.
      const data = opened(entry)
      if (data === undefined) {
        const script = new Script(code, { filename })
        counts.rejected++
        schedule(file, script)
        return script
      }
      const script = new Script(code, { filename, cachedData: data })
      if (script.cachedDataRejected === true) {
        counts.rejected++
        schedule(file, script)
      } else {
        counts.hits++
      }
      return script
    },
    async flush() {
      await Promise.all([...inFlight.values()])
    },
    get stats() {
      return { ...counts }
    },
  }
}
