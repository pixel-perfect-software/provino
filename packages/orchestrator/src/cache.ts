// T9.6's local results cache: per file, how the last run went and how long it took. It orders the
// next run (failed files first, longest first). Read once, written once per run.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileHistory } from '@provino/types'

/** The file's name inside the cache directory. */
const FILE_NAME = 'results.json'

/** The format version; a file with another one is treated as empty. */
const VERSION = 1

/**
 * The directory the results cache lives in by default: `<rootDir>/node_modules/.cache/provino`.
 * @public
 */
export function defaultCacheDir(rootDir: string): string {
  return join(rootDir, 'node_modules', '.cache', 'provino')
}

/**
 * The history of past runs, per project and file.
 * @public
 */
export interface ResultsCache {
  /** What the cache knows of the file; `path` is relative to the project root, with `/`. */
  get(project: string, path: string): FileHistory | undefined
  /** Replaces the file's history in memory. Nothing reaches the disk until `write`. */
  record(project: string, path: string, history: FileHistory): void
  /**
   * Writes the cache to its directory (created if need be): a temporary file, then a rename, so a
   * reader or a second run never sees half a file. Rejects when the directory can't be written;
   * the caller decides whether that matters.
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

/**
 * Opens the results cache in `dir` (see `defaultCacheDir`): reads `results.json` once, now. A file
 * that is missing, can't be read, isn't JSON, or has another `version` is an empty cache, never an
 * error; so is a bad entry. The cache is a value the caller passes along, not module state, so two
 * runs in one process don't share one by accident.
 * @public
 */
export function createResultsCache(dir: string): ResultsCache {
  const file = join(dir, FILE_NAME)
  const projects = read(file)
  return {
    get: (project, path) => projects.get(project)?.get(path),
    record(project, path, history) {
      let files = projects.get(project)
      if (files === undefined) {
        files = new Map()
        projects.set(project, files)
      }
      files.set(path, history)
    },
    async write() {
      const body = {
        version: VERSION,
        projects: Object.fromEntries(
          [...projects].map(([project, files]) => [project, Object.fromEntries(files)]),
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
