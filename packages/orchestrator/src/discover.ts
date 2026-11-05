// U2, minimal: the project's `include` and `exclude` globs through tinyglobby. `roots`,
// `testRegex` and regex ignores are B14's; this is `include`/`exclude` and nothing else.
import { stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { glob } from 'tinyglobby'

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

/** How many files are `stat`ed at once. */
const STAT_BATCH = 256

/** Code point order, the same on every machine. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
  const found: DiscoveredFile[] = []
  // A bounded number of `stat`s at a time: a project can have thousands of files.
  for (let from = 0; from < paths.length; from += STAT_BATCH) {
    const batch = await Promise.all(
      paths.slice(from, from + STAT_BATCH).map((path) => describe(rootDir, path)),
    )
    for (const file of batch) if (file !== undefined) found.push(file)
  }
  return found.sort((a, b) => byText(a.relativePath, b.relativePath))
}

/** The file at `path`, or `undefined` when it vanished since the glob saw it. */
async function describe(rootDir: string, path: string): Promise<DiscoveredFile | undefined> {
  try {
    const { size } = await stat(path)
    return { path, relativePath: relative(rootDir, path).split(sep).join('/'), sizeBytes: size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
