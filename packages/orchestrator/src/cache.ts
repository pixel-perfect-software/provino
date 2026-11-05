// T9.6's local results cache: per file, how the last run went and how long it took. It orders the
// next run (failed files first, longest first). Read when it is opened, written once per run: the
// write reads the file again and puts this run's entries on top, so runs that overlap keep each
// other's history.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileHistory } from '@provino/types'

/** The file's name inside the cache directory. */
const FILE_NAME = 'results.json'

/**
 * The format version; a file with another one is treated as empty. 2: the project key is the
 * project's name and a hash of its root and globs (1 keyed by the bare name).
 */
const VERSION = 2

/**
 * The directory the results cache lives in by default: `<rootDir>/node_modules/.cache/provino`.
 * @public
 */
export function defaultCacheDir(rootDir: string): string {
  return join(rootDir, 'node_modules', '.cache', 'provino')
}

/**
 * The history of past runs, per project and file. `project` is whatever key tells the project's
 * configs apart (`runProject` uses its name and a hash of its root and globs).
 * @public
 */
export interface ResultsCache {
  /** What the cache knows of the file; `path` is relative to the project root, with `/`. */
  get(project: string, path: string): FileHistory | undefined
  /** Replaces the file's history in memory. Nothing reaches the disk until `write`. */
  record(project: string, path: string, history: FileHistory): void
  /**
   * Forgets the project's history of every file not in `keep`: at once in memory, and on the disk
   * at `write` (including entries another run wrote since this cache was opened). `keep` must be
   * the project's whole file set, so call it only for a run that looked at all of it; a run that
   * only saw some of the files (a filter) would drop the history of the rest.
   */
  prune(project: string, keep: ReadonlySet<string>): void
  /**
   * Writes the cache to its directory (created if need be). It reads `results.json` again first
   * (a missing, unreadable or other-version file is empty, as when the cache was opened), applies
   * this cache's `record`ed entries and `prune`s on top of what is there, and writes the result as
   * a temporary file, then a rename, so a reader or a second run never sees half a file and a run
   * that wrote in the meantime keeps its entries. Two writes in the very same instant can still
   * lose one run's entries: the history is a hint for the order of the next run, not a ledger.
   * Rejects when the directory can't be written; the caller decides whether that matters.
   */
  write(): Promise<void>
}

type Projects = Map<string, Map<string, FileHistory>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHistory(value: unknown): value is FileHistory {
  return (
    isRecord(value) &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    typeof value.failed === 'boolean' &&
    typeof value.tests === 'number' &&
    typeof value.at === 'number'
  )
}

/** The projects in `text`; anything unreadable, or of another version, is no history at all. */
function parse(text: string): Projects {
  const projects: Projects = new Map()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return projects
  }
  if (!isRecord(data) || data.version !== VERSION || !isRecord(data.projects)) return projects
  for (const [project, files] of Object.entries(data.projects)) {
    if (!isRecord(files)) continue
    const known = new Map<string, FileHistory>()
    for (const [path, history] of Object.entries(files)) {
      // One bad entry costs that file its history, not the whole cache.
      if (isHistory(history)) known.set(path, history)
    }
    projects.set(project, known)
  }
  return projects
}

function read(file: string): Projects {
  try {
    return parse(readFileSync(file, 'utf8'))
  } catch {
    return new Map()
  }
}

async function load(file: string): Promise<Projects> {
  try {
    return parse(await readFile(file, 'utf8'))
  } catch {
    return new Map()
  }
}

function filesOf(projects: Projects, project: string): Map<string, FileHistory> {
  let files = projects.get(project)
  if (files === undefined) {
    files = new Map()
    projects.set(project, files)
  }
  return files
}

/** Removes the entries whose path is not in `keep`. */
function dropOutside(files: Map<string, FileHistory> | undefined, keep: ReadonlySet<string>): void {
  if (files === undefined) return
  for (const path of [...files.keys()]) {
    if (!keep.has(path)) files.delete(path)
  }
}

/**
 * Opens the results cache in `dir` (see `defaultCacheDir`): reads `results.json` now, for `get`
 * (`write` reads it again). A file that is missing, can't be read, isn't JSON, or has another
 * `version` is an empty cache, never an error; so is a bad entry. The cache is a value the caller
 * passes along, not module state, so two runs in one process don't share one by accident.
 * @public
 */
export function createResultsCache(dir: string): ResultsCache {
  const file = join(dir, FILE_NAME)
  /** What `get` answers from: the file as it was when opened, plus what this cache recorded. */
  const projects = read(file)
  /** Only what this cache recorded: what `write` puts on top of the disk's. */
  const recorded: Projects = new Map()
  /** The files `prune` kept, by project: what `write` drops from the disk's. */
  const kept = new Map<string, ReadonlySet<string>>()
  return {
    get: (project, path) => projects.get(project)?.get(path),
    record(project, path, history) {
      filesOf(projects, project).set(path, history)
      filesOf(recorded, project).set(path, history)
    },
    prune(project, keep) {
      const paths = new Set(keep)
      kept.set(project, paths)
      dropOutside(projects.get(project), paths)
      dropOutside(recorded.get(project), paths)
    },
    async write() {
      // Another run may have written since this cache was opened: start from the file as it is.
      const merged = await load(file)
      for (const [project, paths] of kept) dropOutside(merged.get(project), paths)
      for (const [project, files] of recorded) {
        const into = filesOf(merged, project)
        for (const [path, history] of files) into.set(path, history)
      }
      const body = {
        version: VERSION,
        projects: Object.fromEntries(
          [...merged]
            .filter(([, files]) => files.size > 0)
            .map(([project, files]) => [project, Object.fromEntries(files)]),
        ),
      }
      await mkdir(dir, { recursive: true })
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(body))
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
  }
}
