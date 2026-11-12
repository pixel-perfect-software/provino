// T3.6: the on-disk transform cache. One file per key at `<dir>/<2 hex>/<key>`: a one-line JSON
// header (the record's facts and the lengths in bytes of the code and the map), a newline, the code,
// then the map's JSON text, then (when the record has a runner form) its code and its edits' JSON.
// The map is parsed lazily and parsed on first use: a warm run reads thousands of
// records and asks for a map only when a stack trace needs one. A write is
// a temporary file and a rename, so a reader sees a whole entry or none, and a reader that finds
// the wrong length treats the entry as a miss. Everything is best effort: a cache that can't be
// read or written is a cache that misses, never an error that fails a transform.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ImportRecord,
  RunnerEdit,
  RunnerForm,
  SourceMapV3,
  StaticMockCall,
  TransformDiagnostic,
  TransformRecord,
} from '@provino/types'

/** The entry format. Another version reads as a miss. */
const VERSION = 2

/**
 * The text of `CACHEDIR.TAG`, as the specification (bford.info/cachedir) asks, so backup tools skip
 * the directory.
 */
const CACHEDIR_TAG = `Signature: 8a477f597d28d172789f06886806bc55
# This file is a cache directory tag created by Provino.
# For information about cache directory tags, see: https://bford.info/cachedir/
`

/**
 * The sentinel the first `set` of a process leaves in the directory: `pruneCacheIfWritten` prunes
 * when it exists and removes it.
 * @internal
 */
export const WRITTEN_NAME = '.written'

/**
 * The name of the tag file in a cache directory.
 * @internal
 */
export const CACHEDIR_TAG_NAME = 'CACHEDIR.TAG'

/**
 * Whether `dir` holds the `CACHEDIR.TAG` Provino wrote: the signature and the creator's name. A
 * directory a user made, with a tag of another tool or none, is not Provino's.
 * @public
 */
export function hasProvinoTag(dir: string): boolean {
  try {
    const tag = readFileSync(join(dir, CACHEDIR_TAG_NAME), 'utf8')
    return (
      tag.startsWith(CACHEDIR_TAG.slice(0, CACHEDIR_TAG.indexOf('\n'))) && tag.includes('Provino')
    )
  } catch {
    return false
  }
}

/**
 * What an entry holds: the record without its key and `fromCache`, which the lookup supplies.
 * @internal
 */
export type CachedRecord = Omit<TransformRecord, 'cacheKey' | 'fromCache'>

interface Header {
  readonly v: number
  readonly codeBytes: number
  /** The length of the map's JSON text after the code; `0` for no map. */
  readonly mapBytes: number
  readonly format: TransformRecord['format']
  readonly imports: readonly ImportRecord[]
  readonly staticMocks: readonly StaticMockCall[]
  readonly hasTopLevelAwait: boolean
  readonly lateDeps: readonly string[]
  readonly diagnostics: readonly TransformDiagnostic[]
  /** The runner form (B20, Q3), after the map: its code's length, its edits' JSON length, its deps. */
  readonly runner: {
    readonly codeBytes: number
    readonly editBytes: number
    readonly deps: readonly string[]
    readonly dynamicDeps: readonly string[]
  } | null
}

/**
 * A directory of cached transform records.
 * @public
 */
export interface TransformCache {
  /** The record stored under `key` (with `cacheKey` and `fromCache: true`), or `undefined`. */
  get(key: string): TransformRecord | undefined
  /**
   * Stores `record` under `key`. A record with an error diagnostic is not stored: a parse error or
   * a failed transformer should be met again, not replayed. Warnings are stored and replayed.
   */
  set(key: string, record: TransformRecord): void
}

function isRunnerHeader(value: unknown): value is NonNullable<Header['runner']> {
  if (typeof value !== 'object' || value === null) return false
  const runner = value as Record<string, unknown>
  return (
    typeof runner.codeBytes === 'number' &&
    typeof runner.editBytes === 'number' &&
    Array.isArray(runner.deps) &&
    Array.isArray(runner.dynamicDeps)
  )
}

function isHeader(value: unknown): value is Header {
  if (typeof value !== 'object' || value === null) return false
  const header = value as Record<string, unknown>
  return (
    header.v === VERSION &&
    typeof header.codeBytes === 'number' &&
    typeof header.mapBytes === 'number' &&
    typeof header.hasTopLevelAwait === 'boolean' &&
    typeof header.format === 'string' &&
    Array.isArray(header.imports) &&
    Array.isArray(header.staticMocks) &&
    Array.isArray(header.lateDeps) &&
    Array.isArray(header.diagnostics) &&
    (header.runner === null || isRunnerHeader(header.runner))
  )
}

/** Writes `CACHEDIR.TAG` into `dir` unless it is there. */
export function writeCacheTag(dir: string): void {
  try {
    writeFileSync(join(dir, CACHEDIR_TAG_NAME), CACHEDIR_TAG, { flag: 'wx' })
  } catch {
    // Already there, or the directory can't be written to: the entries will fail the same way.
  }
}

/**
 * Opens the cache in `dir`. Nothing is created until the first `set`.
 * @public
 */
export function createTransformCache(dir: string): TransformCache {
  const madeDirs = new Set<string>()
  let tagged = false
  let marked = false
  let counter = 0
  // Distinct per process and per cache object, so two writers never share a temporary name.
  const nonce = `${process.pid}.${randomBytes(4).toString('hex')}`

  function pathFor(key: string): { readonly shard: string; readonly file: string } {
    const shard = join(dir, key.slice(0, 2))
    return { shard, file: join(shard, key) }
  }

  return {
    get(key) {
      let data: Buffer
      try {
        data = readFileSync(pathFor(key).file)
      } catch {
        return undefined
      }
      try {
        const newline = data.indexOf(0x0a)
        if (newline < 0) return undefined
        const header: unknown = JSON.parse(data.toString('utf8', 0, newline))
        if (!isHeader(header)) return undefined
        const codeStart = newline + 1
        const mapStart = codeStart + header.codeBytes
        const runnerStart = mapStart + header.mapBytes
        const editsStart = runnerStart + (header.runner?.codeBytes ?? 0)
        if (data.length !== editsStart + (header.runner?.editBytes ?? 0)) return undefined
        let map: SourceMapV3 | null | undefined = header.mapBytes === 0 ? null : undefined
        let code: string | undefined
        let runner: RunnerForm | undefined
        if (header.runner !== null) {
          const stored = header.runner
          let runnerCode: string | undefined
          let edits: RunnerEdit[] | undefined
          runner = {
            // Decoded on first read: a warm run evaluates the runner form and never reads the other.
            get code(): string {
              runnerCode ??= data.toString('utf8', runnerStart, editsStart)
              return runnerCode
            },
            deps: stored.deps,
            dynamicDeps: stored.dynamicDeps,
            get edits(): readonly RunnerEdit[] {
              edits ??= JSON.parse(data.toString('utf8', editsStart)) as RunnerEdit[]
              return edits
            },
          }
        }
        return {
          get code(): string {
            code ??= data.toString('utf8', codeStart, mapStart)
            return code
          },
          get map(): SourceMapV3 | null {
            // A map that fails to parse reads as none: the code is whole, and a stack is still a
            // stack. Memoized, so the parse happens at most once.
            if (map === undefined) {
              try {
                map = JSON.parse(data.toString('utf8', mapStart, runnerStart)) as SourceMapV3
              } catch {
                map = null
              }
            }
            return map
          },
          format: header.format,
          imports: header.imports,
          staticMocks: header.staticMocks,
          hasTopLevelAwait: header.hasTopLevelAwait,
          lateDeps: header.lateDeps,
          diagnostics: header.diagnostics,
          cacheKey: key,
          fromCache: true,
          ...(runner === undefined ? {} : { runner }),
        }
      } catch {
        return undefined
      }
    },

    set(key, record) {
      if (record.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return
      const { shard, file } = pathFor(key)
      const temporary = `${file}.${nonce}.${counter++}.tmp`
      try {
        if (!madeDirs.has(shard)) {
          mkdirSync(shard, { recursive: true })
          madeDirs.add(shard)
          if (!tagged) {
            writeCacheTag(dir)
            tagged = true
          }
        }
        const code = Buffer.from(record.code, 'utf8')
        const map = record.map === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(record.map))
        const runnerCode =
          record.runner === undefined ? null : Buffer.from(record.runner.code, 'utf8')
        const runnerEdits =
          record.runner === undefined ? null : Buffer.from(JSON.stringify(record.runner.edits))
        const header: Header = {
          v: VERSION,
          codeBytes: code.length,
          mapBytes: map.length,
          format: record.format,
          imports: record.imports,
          staticMocks: record.staticMocks,
          hasTopLevelAwait: record.hasTopLevelAwait,
          lateDeps: record.lateDeps,
          diagnostics: record.diagnostics,
          runner:
            record.runner === undefined || runnerCode === null || runnerEdits === null
              ? null
              : {
                  codeBytes: runnerCode.length,
                  editBytes: runnerEdits.length,
                  deps: record.runner.deps,
                  dynamicDeps: record.runner.dynamicDeps,
                },
        }
        // JSON.stringify never writes a raw newline, so the first one ends the header.
        writeFileSync(
          temporary,
          Buffer.concat([
            Buffer.from(`${JSON.stringify(header)}\n`),
            code,
            map,
            runnerCode ?? Buffer.alloc(0),
            runnerEdits ?? Buffer.alloc(0),
          ]),
        )
        renameSync(temporary, file)
        if (!marked) {
          writeFileSync(join(dir, WRITTEN_NAME), '')
          marked = true
        }
      } catch {
        // Best effort. The shard may have been removed by a wipe or a prune: forget it.
        madeDirs.delete(shard)
        try {
          rmSync(temporary, { force: true })
        } catch {
          // Nothing more to do.
        }
      }
    },
  }
}
