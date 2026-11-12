// T3.6: the coordinator's half of the transform cache. The worker reads and writes entries from
// `loader.cacheDir`; this wipes the directory when the lockfile changed, hands the directory to the
// project's workers, and prunes it after the run. The directory's location is the caller's: the
// orchestrator puts it under the results cache's directory, so `--clearCache` and a cold bench run
// that delete one delete the other.
import { lockfileHash, prepareCache, pruneCacheIfWritten } from '@provino/transform'
import type { ResolvedProject } from './resolve.ts'

/**
 * `project` with its workers' transform cache directory set to `dir`, after `dir` is made ready:
 * wiped when the project's lockfile is not the one it was filled under. When the wipe fails twice
 * the project comes back without a `cacheDir` and a process warning says so. Never throws.
 * `lockfiles`, shared by the projects of one run, holds each lockfile's hash by path.
 * @public
 */
export function withTransformCache(
  project: ResolvedProject,
  dir: string,
  lockfiles?: Map<string, string>,
): ResolvedProject {
  if (!prepareCache(dir, lockfileHash(project.rootDir, lockfiles))) {
    // Stale entries that could not be removed must not be served: this run goes without the cache.
    process.emitWarning(
      `Provino could not clear the transform cache at ${dir}; this run uses no transform cache.`,
      { code: 'PROVINO_TRANSFORM_CACHE_STALE' },
    )
    return project
  }
  return {
    ...project,
    config: { ...project.config, loader: { ...project.config.loader, cacheDir: dir } },
  }
}

/**
 * Evicts the oldest entries of the transform cache in `dir` down to its size cap (512 MB), unless
 * no entry was written since the last time this ran. Never throws.
 * @public
 */
export function pruneTransformCache(dir: string): void {
  pruneCacheIfWritten(dir)
}
