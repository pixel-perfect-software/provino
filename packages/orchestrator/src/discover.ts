// U2: the project's `include` and `exclude` globs through tinyglobby. A dialect reader's own rules
// (`roots`, `testMatch`, `testRegex`, the ignore patterns) are `discover-rules.ts`.
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { glob } from 'tinyglobby'
import { relativePosix } from './file-id.ts'
import { BATCH, byText, mapInBatches } from './util.ts'

/**
 * Where to look for test files.
 * @public
 */
export interface DiscoverOptions {
  /** The project root: the globs are relative to it. */
  readonly rootDir: string
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

/**
 * A test file the glob found.
 * @public
 */
export interface DiscoveredFile {
  /** The absolute path, in the platform's own form. */
  readonly path: string
  /** Relative to `rootDir`, with `/` separators: what task ids and reporters use. */
  readonly relativePath: string
  readonly sizeBytes: number
}

/** What `stat` says of one found path: its size and which file on which device it is. */
interface Found {
  readonly path: string
  readonly sizeBytes: number
  readonly id: string
}

/**
 * Finds the project's test files: everything `include` matches under `rootDir` that `exclude`
 * doesn't, dot files and dot directories too (a pattern has to say so to leave them out). The
 * result is sorted by relative path, so it doesn't depend on how the file system lists a
 * directory. A file that vanishes between the glob and its `stat` is left out.
 * @public
 */
export async function discoverFiles(options: DiscoverOptions): Promise<readonly DiscoveredFile[]> {
  const { rootDir, include, exclude } = options
  if (include.length === 0) return []
  const matches = await glob([...include], {
    cwd: rootDir,
    ignore: [...exclude],
    absolute: true,
    dot: true,
  })
  const paths = [...new Set(matches.map((match) => resolve(match)))]
  const stats = await mapInBatches(paths, BATCH, statOf)
  // Paths that are one file on one device may be one file reached twice (a symlinked directory);
  // only those are resolved.
  const byId = new Map<string, Found[]>()
  for (const found of stats) {
    if (found === undefined) continue
    const same = byId.get(found.id)
    if (same === undefined) byId.set(found.id, [found])
    else same.push(found)
  }
  const unique: Found[] = []
  for (const same of byId.values()) {
    if (same.length === 1) unique.push(...same)
    else unique.push(...(await oneEach(same)))
  }
  return unique
    .map(({ path, sizeBytes }) => ({ path, relativePath: relativePosix(rootDir, path), sizeBytes }))
    .sort((a, b) => byText(a.relativePath, b.relativePath))
}

/**
 * One path per real file out of paths that `stat` could not tell apart: a file reached through a
 * symlinked directory (or a loop of them) is found at several paths, and the real path is kept
 * when it was found, else the first in sort order. (A hard link is another path to the same inode
 * but not the same real path: it stays.) A path that can't be resolved (vanished since the glob)
 * is kept as it is.
 */
async function oneEach(same: readonly Found[]): Promise<Found[]> {
  const real = await mapInBatches(same, BATCH, (found) =>
    realpath(found.path).catch(() => found.path),
  )
  const sorted = same
    .map((found, index) => ({ found, real: real[index] ?? found.path }))
    .sort((a, b) => byText(a.found.path, b.found.path))
  const firstOf = new Map<string, Found>()
  // The real path itself wins when the glob found it (not `a/loop/a/x.test.js` over `a/x.test.js`);
  // else the first in sort order.
  for (const entry of sorted)
    if (entry.found.path === entry.real) firstOf.set(entry.real, entry.found)
  for (const entry of sorted) if (!firstOf.has(entry.real)) firstOf.set(entry.real, entry.found)
  return [...firstOf.values()]
}

/** The file at `path`, or `undefined` when it vanished since the glob saw it. */
async function statOf(path: string): Promise<Found | undefined> {
  try {
    const { size, dev, ino } = await stat(path, { bigint: true })
    return { path, sizeBytes: Number(size), id: `${dev}:${ino}` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
