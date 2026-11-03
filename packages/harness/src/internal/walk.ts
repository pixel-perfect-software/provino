// The one directory walk the recorder uses: fixture files, snapshot files, golden files and
// fixture discovery all list files under a root and differ only in what they skip and keep.
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { compareStrings } from './guards.ts'

/** What `walkFiles` skips and keeps. Both receive POSIX paths relative to the root. */
export interface WalkOptions {
  /** True for a directory not to enter. Default: enter every directory. */
  readonly skipDir?: (relativeDir: string) => boolean
  /** True for a file to list. Default: list every file. */
  readonly keep?: (relativeFile: string) => boolean
}

/** Whether a relative path is `node_modules` or ends in a segment of that name. */
export function isNodeModules(relative: string): boolean {
  return path.posix.basename(relative) === 'node_modules'
}

/**
 * Every regular file under `root` that `keep` accepts, as POSIX paths relative to `root`, sorted in
 * code-point order. A directory `skipDir` accepts is not entered. Symbolic links are not followed
 * and not listed. A `root` that can't be read rejects.
 * @internal
 */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const out: string[] = []
  const walk = async (prefix: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (!(options.skipDir?.(relative) ?? false)) await walk(relative)
      } else if (entry.isFile() && (options.keep?.(relative) ?? true)) {
        out.push(relative)
      }
    }
  }
  await walk('')
  return out.toSorted(compareStrings)
}
