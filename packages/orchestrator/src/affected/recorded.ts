// T9.12: the recorded graph. Each test file's `deps` event (the modules it really loaded) is kept
// with the time the file ran, so a later run can select by what a file loaded instead of what its
// sources say it imports. A record is trusted only while it is newer than the file and every
// module in it (`freshDeps`). The paths are interned: one table, and each file's list is numbers.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isRecord } from '../util.ts'

const VERSION = 1

interface Recorded {
  /** When the file ran, in ms since the epoch. */
  readonly at: number
  readonly deps: readonly string[]
}

/**
 * The modules each test file loaded when it last ran.
 * @beta
 */
export interface RecordedGraph {
  /** What `record` or the file on disk says of `test`. */
  get(test: string): Recorded | undefined
  /** Replaces `test`'s record in memory. */
  record(test: string, deps: readonly string[], at: number): void
  /** Forgets the records of tests not in `keep`. */
  prune(keep: ReadonlySet<string>): void
  /** Writes the records (a temp file, then a rename) if any changed. */
  save(): Promise<void>
}

function parse(text: string): Map<string, Recorded> {
  const records = new Map<string, Recorded>()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return records
  }
  if (!isRecord(data) || data.version !== VERSION || !Array.isArray(data.paths)) return records
  const paths: unknown[] = data.paths
  if (!isRecord(data.files)) return records
  for (const [test, value] of Object.entries(data.files)) {
    if (!isRecord(value) || typeof value.at !== 'number' || !Array.isArray(value.d)) continue
    const deps: string[] = []
    for (const id of value.d) {
      const path = typeof id === 'number' ? paths[id] : undefined
      if (typeof path === 'string') deps.push(path)
    }
    if (deps.length === value.d.length) records.set(test, { at: value.at, deps })
  }
  return records
}

/**
 * Opens the recorded graph at `file`; a missing, corrupt or other-version file is an empty one.
 * @beta
 */
export async function openRecordedGraph(file: string): Promise<RecordedGraph> {
  let records: Map<string, Recorded>
  try {
    records = parse(await readFile(file, 'utf8'))
  } catch {
    records = new Map()
  }
  let dirty = false
  return {
    get: (test) => records.get(test),
    record(test, deps, at) {
      records.set(test, { at, deps })
      dirty = true
    },
    prune(keep) {
      for (const test of [...records.keys()]) {
        if (!keep.has(test)) {
          records.delete(test)
          dirty = true
        }
      }
    },
    async save() {
      if (!dirty) return
      const table = new Map<string, number>()
      const idOf = (path: string): number => {
        let id = table.get(path)
        if (id === undefined) {
          id = table.size
          table.set(path, id)
        }
        return id
      }
      const files: Record<string, { at: number; d: number[] }> = {}
      for (const [test, { at, deps }] of records) files[test] = { at, d: deps.map(idOf) }
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(
          temporary,
          JSON.stringify({ version: VERSION, paths: [...table.keys()], files }),
        )
        await rename(temporary, file)
        dirty = false
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
  }
}

/**
 * The recorded modules of `test`, when the record is newer than the test file and every module in
 * it (`mtimeOf` answers a path's mtime in ms, or `undefined` for one that is gone): else
 * `undefined`, and the sources are read instead.
 * @internal
 */
export function freshDeps(
  graph: RecordedGraph,
  test: string,
  mtimeOf: (path: string) => number | undefined,
): readonly string[] | undefined {
  const record = graph.get(test)
  if (record === undefined) return undefined
  for (const path of [test, ...record.deps]) {
    const mtime = mtimeOf(path)
    if (mtime === undefined || mtime > record.at) return undefined
  }
  return record.deps
}
