// D127: the node_modules files a project's workers learned to evaluate per file, as the results
// cache carries them between runs. Each is kept with its package's `version`, so a reinstall that
// moves or upgrades a package drops what was learned of it, rather than the set only growing.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageDirOf } from '@provino/loader/graph'
import type { ResultsCache } from './cache.ts'
import { relativePosix } from './file-id.ts'

/**
 * The `version` of the package.json of the package `path` is in (`''` when it has none or can't be
 * read), memoized by package directory for one run.
 */
export function packageVersionOf(path: string, memo: Map<string, string>): string {
  const dir = packageDirOf(path)
  if (dir === null) return ''
  const known = memo.get(dir)
  if (known !== undefined) return known
  let version = ''
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const value = parsed.version
      if (typeof value === 'string') version = value
    }
  } catch {
    // No package.json, or not one: no version.
  }
  memo.set(dir, version)
  return version
}

/**
 * What `project` learned in earlier runs, as absolute paths, for its workers. An entry whose file
 * is gone, or whose package has another version now, is dropped from the cache (`forgetExternals`)
 * and not returned.
 */
export function readLearnedExternals(
  cache: ResultsCache,
  project: string,
  rootDir: string,
  memo: Map<string, string>,
): string[] {
  const learned: string[] = []
  const stale: string[] = []
  for (const [path, version] of cache.externals(project)) {
    const absolute = join(rootDir, path)
    if (existsSync(absolute) && packageVersionOf(absolute, memo) === version) {
      learned.push(absolute)
    } else {
      stale.push(path)
    }
  }
  if (stale.length > 0) cache.forgetExternals(project, stale)
  return learned
}

/** Adds what a worker learned (absolute paths) to the project's entry, with each package's version. */
export function learnExternals(
  cache: ResultsCache,
  project: string,
  rootDir: string,
  paths: readonly string[],
  memo: Map<string, string>,
): void {
  cache.learnExternals(
    project,
    paths.map((path) => [relativePosix(rootDir, path), packageVersionOf(path, memo)] as const),
  )
}
