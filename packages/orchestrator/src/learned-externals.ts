// D127: the node_modules files a project's workers learned to evaluate per file, as the results
// cache carries them between runs. Each is kept with its package's `version`, so a reinstall that
// moves or upgrades a package drops what was learned of it, rather than the set only growing.
// D132: the files they loaded natively, kept the same way, so the next run's workers know the
// shared importers a cold worker's first file loaded before their seeds join.
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
  return freshPaths(cache.externals(project), rootDir, memo, (stale) =>
    cache.forgetExternals(project, stale),
  )
}

/**
 * What `project`'s workers loaded natively in earlier runs (D132), as absolute paths, pruned as
 * `readLearnedExternals` prunes (`forgetLoadedExternals`).
 */
export function readLoadedExternals(
  cache: ResultsCache,
  project: string,
  rootDir: string,
  memo: Map<string, string>,
): string[] {
  return freshPaths(cache.loadedExternals(project), rootDir, memo, (stale) =>
    cache.forgetLoadedExternals(project, stale),
  )
}

/**
 * The entries of `entries` (relative paths with their versions) whose file is there with the same
 * package version, as absolute paths; the rest go to `forget`.
 */
function freshPaths(
  entries: ReadonlyMap<string, string>,
  rootDir: string,
  memo: Map<string, string>,
  forget: (stale: readonly string[]) => void,
): string[] {
  const fresh: string[] = []
  const stale: string[] = []
  for (const [path, version] of entries) {
    const absolute = join(rootDir, path)
    if (existsSync(absolute) && packageVersionOf(absolute, memo) === version) {
      fresh.push(absolute)
    } else {
      stale.push(path)
    }
  }
  if (stale.length > 0) forget(stale)
  return fresh
}

/** Adds what a worker learned (absolute paths) to the project's entry, with each package's version. */
export function learnExternals(
  cache: ResultsCache,
  project: string,
  rootDir: string,
  paths: readonly string[],
  memo: Map<string, string>,
): void {
  cache.learnExternals(project, versioned(rootDir, paths, memo))
}

/** Adds what a worker loaded natively (absolute paths, D132) to the project's entry, likewise. */
export function recordLoadedExternals(
  cache: ResultsCache,
  project: string,
  rootDir: string,
  paths: readonly string[],
  memo: Map<string, string>,
): void {
  cache.recordLoadedExternals(project, versioned(rootDir, paths, memo))
}

/** Each path relative to `rootDir`, with its package's version. */
function versioned(
  rootDir: string,
  paths: readonly string[],
  memo: Map<string, string>,
): (readonly [string, string])[] {
  return paths.map((path) => [relativePosix(rootDir, path), packageVersionOf(path, memo)] as const)
}
