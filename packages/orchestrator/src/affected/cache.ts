// T9.12: the edge cache. The specifiers each file imports, keyed by the file's mtime and size and by
// the extractor's identity, in one JSON file per project. It is read once, rewritten whole with a
// temp file and a rename, and a corrupt or other-version file is an empty cache. An entry read
// within a timestamp's granularity of the file's mtime is "racily clean", as git calls it: a save
// in the same tick could leave the same mtime and size, so the entry is never served and the file is
// read again.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isRecord } from '../util.ts'

const VERSION = 2

/**
 * How close a read may come to the file's mtime and still be trusted: the coarsest timestamp a
 * common file system keeps (FAT's 2 s; HFS+ keeps 1 s, and Linux stamps from a clock that ticks
 * every few ms).
 */
const RACY_MS = 2000

/** One file's specifiers, with what they were read from. */
interface Entry {
  /** mtime in ms. */
  readonly m: number
  /** Size in bytes. */
  readonly s: number
  /** The specifiers, as written. */
  readonly e: readonly string[]
  /** When the file was read, in ms since the epoch. */
  readonly w: number
}

/**
 * The specifiers of the files the last index read.
 * @internal
 */
export interface EdgeCache {
  /**
   * The cached specifiers of `path`, when its mtime and size are what they were read at and the
   * read came clearly after that mtime.
   */
  get(path: string, mtimeMs: number, size: number): readonly string[] | undefined
  /** Remembers `path`'s specifiers, read at `readAt` (ms); nothing reaches the disk until `save`. */
  set(
    path: string,
    mtimeMs: number,
    size: number,
    specifiers: readonly string[],
    readAt: number,
  ): void
  /** Writes the cache if anything was set since it was opened. */
  save(): Promise<void>
}

function isEntry(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    typeof value.m === 'number' &&
    typeof value.s === 'number' &&
    typeof value.w === 'number' &&
    Array.isArray(value.e) &&
    value.e.every((item) => typeof item === 'string')
  )
}

/** The entries in `text` for `identity`: anything else is an empty cache. */
function parse(text: string, identity: string): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return entries
  }
  if (
    !isRecord(data) ||
    data.version !== VERSION ||
    data.identity !== identity ||
    !isRecord(data.files)
  ) {
    return entries
  }
  for (const [path, entry] of Object.entries(data.files)) {
    if (isEntry(entry)) entries.set(path, entry)
  }
  return entries
}

/**
 * Opens the edge cache at `file` for an extractor (`null`: memory only, a run with no cache). Files that are no longer in the project are
 * dropped on save: only what this index asked for is kept (`touched`).
 * @internal
 */
export async function openEdgeCache(file: string | null, identity: string): Promise<EdgeCache> {
  let entries: Map<string, Entry>
  try {
    entries = file === null ? new Map() : parse(await readFile(file, 'utf8'), identity)
  } catch {
    entries = new Map()
  }
  const touched = new Set<string>()
  let dirty = false
  return {
    get(path, mtimeMs, size) {
      const entry = entries.get(path)
      if (entry === undefined || entry.m !== mtimeMs || entry.s !== size) return undefined
      // Racily clean: a later save in the same tick would look the same.
      if (entry.w - entry.m < RACY_MS) return undefined
      touched.add(path)
      return entry.e
    },
    set(path, mtimeMs, size, specifiers, readAt) {
      entries.set(path, { m: mtimeMs, s: size, e: specifiers, w: readAt })
      touched.add(path)
      dirty = true
    },
    async save() {
      // A file the index no longer asks for is gone from the project.
      if (touched.size !== entries.size) dirty = true
      if (!dirty || file === null) return
      const files: Record<string, Entry> = {}
      for (const path of touched) {
        const entry = entries.get(path)
        if (entry !== undefined) files[path] = entry
      }
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(temporary, JSON.stringify({ version: VERSION, identity, files }))
        await rename(temporary, file)
        entries = new Map(touched.size === 0 ? [] : Object.entries(files))
        dirty = false
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
  }
}
