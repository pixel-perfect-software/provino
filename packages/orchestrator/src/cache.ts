// T9.6's local results cache: per file, how the last run went and how long it took. It orders the
// next run (failed files first, longest first). Read when it is opened, written once per run: the
// write reads the file again and puts this run's entries on top, so runs that overlap keep each
// other's history.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hasProvinoTag } from '@provino/config'
import { isIsolationTier } from '@provino/loader'
import type { FileHistory } from '@provino/types'
import { isRecord } from './util.ts'

/** The file's name inside the cache directory. */
const FILE_NAME = 'results.json'

/**
 * The format version; a file with another one is treated as empty. 2: the project key is the
 * project's name and a hash of its root and globs (1 keyed by the bare name). 3: a file's record
 * may hold an inputs hash, a learned tier and a coverage map (T9.6; nothing writes them yet), so an
 * older reader would drop them. Still 3 with `externals` (D127) and `loadedExternals` (D132)
 * beside `projects`: a reader that doesn't know one keeps every file's history and drops only that,
 * which a worker learns again. A project's entry in either is `{ [path]: version }`, any other
 * shape is none.
 */
const VERSION = 3

/**
 * The directory the results cache lives in: `<cacheDirectory>/provino` when the project's config
 * sets a cache directory itself (D70: CI setups cache it between runs), else
 * `<rootDir>/node_modules/.cache/provino`.
 * @public
 */
export function defaultCacheDir(rootDir: string, cacheDirectory?: string): string {
  if (cacheDirectory !== undefined) return join(cacheDirectory, 'provino')
  return join(rootDir, 'node_modules', '.cache', 'provino')
}

/**
 * Whether `directory` is a Provino cache directory: it holds the `CACHEDIR.TAG` Provino writes
 * (here, in its transform cache's `t` or in the bin's compile cache's `compile`), or the results
 * cache's `results.json`. `--clearCache`
 * removes only such a directory: `<cacheDirectory>/provino` can be a directory the user already had.
 * @public
 */
export function isProvinoCacheDir(directory: string): boolean {
  return (
    existsSync(join(directory, FILE_NAME)) ||
    hasProvinoTag(directory) ||
    hasProvinoTag(join(directory, 't')) ||
    hasProvinoTag(join(directory, 'compile'))
  )
}

/**
 * The directory of the transform cache (T3.6): `t` inside `defaultCacheDir`, so that deleting the
 * results cache's directory (`--clearCache`, a cold bench run) deletes it too.
 * @public
 */
export function transformCacheDir(rootDir: string, cacheDirectory?: string): string {
  return cacheDirectories({ rootDir, cacheDirectory }).transform
}

/**
 * Both cache directories of a project, from one place: the results cache's, and the transform
 * cache's inside it.
 * @public
 */
export function cacheDirectories(project: {
  readonly rootDir: string
  readonly cacheDirectory?: string | undefined
}): { readonly results: string; readonly transform: string } {
  const results = defaultCacheDir(project.rootDir, project.cacheDirectory)
  return { results, transform: join(results, 't') }
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
   * The node_modules files the project's workers learned to evaluate per file
   * (`ModulePolicy.reevaluateHookingExternals`, D127), relative to the project root with `/`, in
   * the order they were learned, each with the `version` of its package's `package.json` when it
   * was learned (`''` for none): a reader drops an entry whose package is gone or has another
   * version since (`forgetExternals`), so the set follows the install.
   */
  externals(project: string): ReadonlyMap<string, string>
  /** Adds files to `externals`, each with its package's version; kept until `write`. */
  learnExternals(project: string, entries: Iterable<readonly [string, string]>): void
  /** Removes files from `externals`, here and from the disk's at `write` (a stale entry). */
  forgetExternals(project: string, paths: Iterable<string>): void
  /**
   * The node_modules files the project's workers loaded natively (`Loader.takeLoadedExternals`,
   * D132), kept as `externals` is: relative to the project root with `/`, each with its package's
   * version, dropped by a reader when the file is gone or the version moved
   * (`forgetLoadedExternals`). The next run's workers know them before `externals` join, so a
   * warm worker keeps shared what a cold one kept shared.
   */
  loadedExternals(project: string): ReadonlyMap<string, string>
  /** Adds files to `loadedExternals`, each with its package's version; kept until `write`. */
  recordLoadedExternals(project: string, entries: Iterable<readonly [string, string]>): void
  /** Removes files from `loadedExternals`, here and from the disk's at `write` (a stale entry). */
  forgetLoadedExternals(project: string, paths: Iterable<string>): void
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

/**
 * Per project, node_modules files and their packages' versions, in the order they came: those
 * evaluated per file (D127), or those loaded natively (D132).
 */
type Externals = Map<string, Map<string, string>>

/** What `results.json` holds. */
interface Contents {
  readonly projects: Projects
  readonly externals: Externals
  /** The same shape: the node_modules files the workers loaded natively (D132). */
  readonly loaded: Externals
}

/** `coverage`: test ids to lists of function ids, all text. */
function isCoverageMap(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (functions) =>
        Array.isArray(functions) && functions.every((item) => typeof item === 'string'),
    )
  )
}

/** A record the cache can use: the four numbers and flags, and each optional field right when present. */
function isHistory(value: unknown): value is FileHistory {
  return (
    isRecord(value) &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    typeof value.failed === 'boolean' &&
    typeof value.tests === 'number' &&
    typeof value.at === 'number' &&
    (value.inputsHash === undefined || typeof value.inputsHash === 'string') &&
    (value.tier === undefined || (typeof value.tier === 'string' && isIsolationTier(value.tier))) &&
    (value.coverage === undefined || isCoverageMap(value.coverage))
  )
}

function empty(): Contents {
  return { projects: new Map(), externals: new Map(), loaded: new Map() }
}

/** Each project's files and versions in `value`, keeping only records of text. */
function parseExternals(value: unknown): Externals {
  const externals: Externals = new Map()
  if (!isRecord(value)) return externals
  for (const [project, paths] of Object.entries(value)) {
    if (!isRecord(paths)) continue
    const entries = Object.entries(paths)
    if (entries.every(([, version]) => typeof version === 'string')) {
      externals.set(project, new Map(entries as [string, string][]))
    }
  }
  return externals
}

/** The contents of `text`; anything unreadable, or of another version, is no history at all. */
function parse(text: string): Contents {
  const contents = empty()
  const { projects } = contents
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return contents
  }
  if (!isRecord(data) || data.version !== VERSION || !isRecord(data.projects)) return contents
  for (const [project, files] of Object.entries(data.projects)) {
    if (!isRecord(files)) continue
    const known = new Map<string, FileHistory>()
    for (const [path, history] of Object.entries(files)) {
      // One bad entry costs that file its history, not the whole cache.
      if (isHistory(history)) known.set(path, history)
    }
    projects.set(project, known)
  }
  return {
    projects,
    externals: parseExternals(data.externals),
    loaded: parseExternals(data.loadedExternals),
  }
}

function read(file: string): Contents {
  try {
    return parse(readFileSync(file, 'utf8'))
  } catch {
    return empty()
  }
}

async function load(file: string): Promise<Contents> {
  try {
    return parse(await readFile(file, 'utf8'))
  } catch {
    return empty()
  }
}

/**
 * Whether a project key's externals and loaded externals are still wanted: the key has file
 * history, or this run added to either list for it. A key whose project was removed, or whose
 * globs (part of the key) changed, has neither, and its lists would otherwise be carried forever.
 */
function hasOwner(projects: Projects, added: readonly Externals[], project: string): boolean {
  return (
    (projects.get(project)?.size ?? 0) > 0 ||
    added.some((list) => (list.get(project)?.size ?? 0) > 0)
  )
}

/** The entry of `map` under `key`, made and kept by `make` when there is none. */
function entryOf<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let entry = map.get(key)
  if (entry === undefined) {
    entry = make()
    map.set(key, entry)
  }
  return entry
}

/** Adds `entries` to the project's files in `externals`. */
function addExternals(
  externals: Externals,
  project: string,
  entries: Iterable<readonly [string, string]>,
): void {
  const known = entryOf(externals, project, () => new Map())
  for (const [path, version] of entries) known.set(path, version)
}

/**
 * One of the cache's per-project lists of node_modules files with their versions (`externals`,
 * `loadedExternals`): what `known` answers from (the file as opened, plus what this cache added,
 * less what it forgot), and what `write` puts on top of the disk's.
 */
interface VersionedFiles {
  readonly known: Externals
  /** Only what this cache added. */
  readonly added: Externals
  /** What this cache removed, by project: what `write` drops from the disk's. */
  readonly forgotten: Map<string, Set<string>>
}

function versionedFiles(known: Externals): VersionedFiles {
  return { known, added: new Map(), forgotten: new Map() }
}

function addVersioned(
  files: VersionedFiles,
  project: string,
  entries: Iterable<readonly [string, string]>,
): void {
  const list = [...entries]
  addExternals(files.known, project, list)
  addExternals(files.added, project, list)
}

function forgetVersioned(files: VersionedFiles, project: string, paths: Iterable<string>): void {
  const dropped = entryOf(files.forgotten, project, () => new Set<string>())
  for (const path of paths) {
    dropped.add(path)
    files.known.get(project)?.delete(path)
    files.added.get(project)?.delete(path)
  }
}

/** Applies what this cache forgot and added to `disk`, the same list as the file holds it now. */
function mergeVersioned(files: VersionedFiles, disk: Externals): void {
  for (const [project, paths] of files.forgotten) {
    const known = disk.get(project)
    if (known !== undefined) for (const path of paths) known.delete(path)
  }
  for (const [project, entries] of files.added) addExternals(disk, project, entries)
}

/** `disk`'s list as `results.json` holds it, less every project key `hasOwner` gives up. */
function versionedBody(
  disk: Externals,
  projects: Projects,
  added: readonly Externals[],
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    [...disk]
      .filter(([project, entries]) => entries.size > 0 && hasOwner(projects, added, project))
      .map(([project, entries]) => [project, Object.fromEntries(entries)]),
  )
}

function filesOf(projects: Projects, project: string): Map<string, FileHistory> {
  return entryOf(projects, project, () => new Map())
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
  const opened = read(file)
  const { projects } = opened
  const externals = versionedFiles(opened.externals)
  const loaded = versionedFiles(opened.loaded)
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
      kept.set(project, keep)
      dropOutside(projects.get(project), keep)
      dropOutside(recorded.get(project), keep)
    },
    externals: (project) => new Map(externals.known.get(project)),
    learnExternals: (project, entries) => addVersioned(externals, project, entries),
    forgetExternals: (project, paths) => forgetVersioned(externals, project, paths),
    loadedExternals: (project) => new Map(loaded.known.get(project)),
    recordLoadedExternals: (project, entries) => addVersioned(loaded, project, entries),
    forgetLoadedExternals: (project, paths) => forgetVersioned(loaded, project, paths),
    async write() {
      // Another run may have written since this cache was opened: start from the file as it is.
      const disk = await load(file)
      const merged = disk.projects
      mergeVersioned(externals, disk.externals)
      mergeVersioned(loaded, disk.loaded)
      const added = [externals.added, loaded.added]
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
        ...(disk.externals.size === 0
          ? {}
          : { externals: versionedBody(disk.externals, merged, added) }),
        ...(disk.loaded.size === 0
          ? {}
          : { loadedExternals: versionedBody(disk.loaded, merged, added) }),
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
