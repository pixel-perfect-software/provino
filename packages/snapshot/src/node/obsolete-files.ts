// Snapshot files no test file has (B23d B1, DV96): Jest's `cleanup` (jest-snapshot 30.5.2
// `index.ts` L117-L155, called once per project after the run by `TestScheduler` L203-L221). Every
// snapshot file under the project's roots is mapped back to its test file (the inverse of the
// snapshot path, the layout's or a project resolver's); one whose test file isn't on disk is
// obsolete, unless that test path is ignored, and under `all` it is deleted.
import { type Dirent, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import type { SnapshotUpdateMode } from '@provino/snapshot'

/**
 * The test file of a snapshot file in the default layout (`<dir>/<dirName>/<file><extension>`):
 * the inverse of `defaultSnapshotPath`, as Jest's default `resolveTestPath` has it (the parent of
 * the snapshot's directory, whatever that directory is called).
 * @public
 */
export function defaultSnapshotTestPath(
  snapshotPath: string,
  layout: { readonly extension: string },
): string {
  return resolve(dirname(snapshotPath), '..', basename(snapshotPath, layout.extension))
}

/**
 * Where to look for obsolete snapshot files, and what to do with them.
 * @public
 */
export interface ObsoleteSnapshotFilesOptions {
  /** Absolute directories crawled for snapshot files. */
  readonly roots: readonly string[]
  /** The snapshot extension (`.snap`); a file is a snapshot file when its name ends in it. */
  readonly extension: string
  /**
   * Regular-expression sources: a path any of them matches is not crawled (Jest's
   * `modulePathIgnorePatterns`, which its haste map tests on directory and file paths alike).
   * Whatever the patterns, a path with `node_modules` or a version-control directory in it is not
   * seen either, above the roots too.
   */
  readonly crawlIgnorePatterns: readonly string[]
  /** Regular-expression sources, joined with `|`: a snapshot whose test path matches is kept. */
  readonly testPathIgnorePatterns: readonly string[]
  /** The test file a snapshot file belongs to (`defaultSnapshotTestPath`, or a resolver's). */
  readonly testPathOf: (snapshotPath: string) => string
  /** `all` deletes what it finds. */
  readonly update: SnapshotUpdateMode
}

/** A path with a `node_modules` directory in it: haste map's `retainAllFiles: false` leaves it out. */
const NODE_MODULES = `${sep}node_modules${sep}`

/** Escapes `text` for a regular expression's source. */
const escapeForRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** jest-haste-map's `VCS_DIRECTORIES` (`index.ts` L107): a path with a `.git`, `.hg` or `.sl` directory in it. */
const VCS_DIRECTORIES: string = ['.git', '.hg', '.sl']
  .map((name) => escapeForRegExp(`${sep}${name}${sep}`))
  .join('|')

/**
 * What jest-haste-map ignores, as it builds it (`index.ts` L248-L262 and `buildIgnoreMatcher`): a
 * path that matches the project's ignore patterns joined with `|` and the version-control
 * directories, or has `node_modules` in it, wherever it is: the roots' own parents count.
 */
function ignorePath(patterns: readonly string[]): (path: string) => boolean {
  const ignored = new RegExp([...patterns, VCS_DIRECTORIES].join('|'))
  return (path) => path.includes(NODE_MODULES) || ignored.test(path)
}

/**
 * Directories a crawl skips unseen: every path below one has `/<name>/` in it, so `ignorePath`
 * drops them all whatever the patterns say.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.sl'])

/**
 * The snapshot files under `root`, as jest-haste-map's crawl lists them. Jest 30's default is
 * its `walk` (`forceNodeFilesystemAPI: true`, `lib/walk.ts`: fdir): a directory is entered unless
 * `ignore` drops its path, with the trailing separator taken off, so `/dir$` prunes `dir`; a file
 * is kept when its `path.extname` is the extension (a file named `.snap` has none) and `ignore`
 * doesn't drop its path. A symlink is neither entered nor listed.
 */
function crawl(
  root: string,
  extension: string,
  ignore: (path: string) => boolean,
  found: Set<string>,
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !ignore(path))
        crawl(path, extension, ignore, found)
    } else if (entry.isFile() && extname(entry.name) === extension && !ignore(path)) {
      found.add(path)
    }
  }
}

/** One regular expression of `|`-joined sources, or `null` for none. */
function joined(patterns: readonly string[]): RegExp | null {
  return patterns.length === 0 ? null : new RegExp(patterns.join('|'))
}

/**
 * The obsolete snapshot files of a project, sorted; deleted when the mode is `all`.
 * @public
 */
export function cleanObsoleteSnapshotFiles(options: ObsoleteSnapshotFilesOptions): string[] {
  const found = new Set<string>()
  const ignore = ignorePath(options.crawlIgnorePatterns)
  const versionControl = new RegExp(VCS_DIRECTORIES)
  for (const root of options.roots) {
    // A root inside `node_modules` or a version-control directory has every path below it dropped.
    const top = `${root}${sep}`
    if (top.includes(NODE_MODULES) || versionControl.test(top)) continue
    crawl(root, options.extension, ignore, found)
  }
  const testIgnored = joined(options.testPathIgnorePatterns)
  const obsolete: string[] = []
  for (const snapshotFile of [...found].sort()) {
    const testPath = options.testPathOf(snapshotFile)
    // ignore snapshots of ignored tests
    if (testIgnored?.test(testPath) === true) continue
    if (!existsSync(testPath)) {
      if (options.update === 'all') unlinkSync(snapshotFile)
      obsolete.push(snapshotFile)
    }
  }
  return obsolete
}
