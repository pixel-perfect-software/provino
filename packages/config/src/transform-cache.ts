// T3.6: the coordinator's half of the transform cache. The worker reads and writes entries from
// `loader.cacheDir`; this wipes the directory when the lockfile changed, hands the directory to the
// project's workers, and prunes it after the run. The directory's location is the caller's: the
// orchestrator puts it under the results cache's directory, so `--clearCache` and a cold bench run
// that delete one delete the other.
import { lockfileHash, prepareCache, pruneCache } from '@provino/transform'
import type { ResolvedProject } from './resolve.ts'

/**
 * `project` with its workers' transform cache directory set to `dir`, after `dir` is made ready:
 * wiped when the project's lockfile is not the one it was filled under. Never throws.
 * @public
 */
export function withTransformCache(project: ResolvedProject, dir: string): ResolvedProject {
  prepareCache(dir, lockfileHash(project.rootDir))
  return {
    ...project,
    config: { ...project.config, loader: { ...project.config.loader, cacheDir: dir } },
  }
}

/**
 * Evicts the oldest entries of the transform cache in `dir` down to its size cap (512 MB). Never
 * throws.
 * @public
 */
export function pruneTransformCache(dir: string): void {
  pruneCache(dir)
}
