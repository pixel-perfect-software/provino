// Snapshot files no test file has (B23d B1, DV96): Jest's `cleanup` (jest-snapshot 30.5.2
// `index.ts` L117-L155, called once per project after the run by `TestScheduler` L203-L221). Every
// snapshot file under the project's roots is mapped back to its test file (the inverse of the
// snapshot path, the layout's or a project resolver's); one whose test file isn't on disk is
// obsolete, unless that test path is ignored, and under `all` it is deleted.
import { type Dirent, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
   * `modulePathIgnorePatterns`, which its haste map leaves out). `node_modules` never is.
   */
  readonly crawlIgnorePatterns: readonly string[]
  /** Regular-expression sources, joined with `|`: a snapshot whose test path matches is kept. */
  readonly testPathIgnorePatterns: readonly string[]
  /** The test file a snapshot file belongs to (`defaultSnapshotTestPath`, or a resolver's). */
  readonly testPathOf: (snapshotPath: string) => string
  /** `all` deletes what it finds. */
  readonly update: SnapshotUpdateMode
}

/** Directories a crawl never enters: dependencies and version control, as Jest's haste map. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.sl'])

/** Every snapshot file under `root`, not following symlinks. */
function crawl(root: string, extension: string, ignored: RegExp | null, found: Set<string>): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (ignored?.test(path) === true) continue
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) crawl(path, extension, ignored, found)
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
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
  const ignored = joined(options.crawlIgnorePatterns)
  for (const root of options.roots) crawl(root, options.extension, ignored, found)
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
