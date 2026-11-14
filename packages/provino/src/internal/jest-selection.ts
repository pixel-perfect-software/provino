// `provino jest`'s changed-file flags (B23c, T9.16): which test files Jest 30.5.2 selects, as
// SearchSource `_getTestPaths` L269-L305 and `runJest` L254-L308 decide it, over the orchestrator's
// primitives. Read from the reader's merged global config, never the raw argv: `-o` comes on with
// `--changedSince`, `--lastCommit` and `--changedFilesWithAncestor`, and off with `--all` or a path
// pattern (jest-config `normalize.ts` L1114-L1154).
import { resolve } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import type { JestGlobalConfig, JestProjectConfig } from '@provino/dialect-jest/node'
import {
  cacheDirectories,
  createResultsCache,
  type DiscoveredFile,
  findChangedFiles,
  hasScm,
  keepFailed,
  projectCacheKey,
  selectAffected,
  selectFiles,
} from '@provino/orchestrator'
import type { AffectedSelection, FileFilter } from '@provino/types'

/**
 * What a run selects by, beyond its file filters: a `selection` in their place (`-o` and the
 * flags that set it, or `--findRelatedTests` with paths) and `--onlyFailures`. `noScm` is a `-o`
 * whose roots are in no repository: it selects nothing, and Jest says why.
 * @internal
 */
export interface JestSelection {
  readonly selection?: AffectedSelection
  readonly onlyFailures?: 'history'
  readonly noScm: boolean
}

/**
 * Jest's order: `-o` first (the changed files of every project's roots, one lookup across them,
 * `getChangedFilesPromise.ts` L16-L41), then `--runTestsByPath` (the request's path filters), then
 * `--findRelatedTests` with paths (resolved against the working directory, as `config.cwd` is),
 * then the patterns. A failing lookup rejects with the provider's error.
 * @internal
 */
export async function jestSelection(
  globalConfig: JestGlobalConfig,
  projects: readonly ResolvedProject[],
  configs: readonly JestProjectConfig[],
  cwd: string,
): Promise<JestSelection> {
  const onlyFailures = globalConfig.onlyFailures ? ({ onlyFailures: 'history' } as const) : {}
  const [first] = projects
  if (globalConfig.onlyChanged && first !== undefined) {
    const roots = [...new Set(configs.flatMap((config) => config.roots))]
    const changed = await findChangedFiles(first.policy.orchestrator.changedFiles, {
      roots,
      ...(globalConfig.changedSince === undefined
        ? {}
        : { changedSince: globalConfig.changedSince }),
      ...(globalConfig.lastCommit ? { lastCommit: true } : {}),
      ...(globalConfig.changedFilesWithAncestor ? { withAncestor: true } : {}),
    })
    return {
      selection: {
        kind: 'changed',
        changed: hasScm(changed) ? changed : { ...changed, changedFiles: [] },
      },
      noScm: !hasScm(changed),
      ...onlyFailures,
    }
  }
  const paths = globalConfig.nonFlagArgs
  if (!globalConfig.runTestsByPath && globalConfig.findRelatedTests && paths.length > 0) {
    return {
      selection: { kind: 'related', paths: paths.map((path) => resolve(cwd, path)) },
      noScm: false,
      ...onlyFailures,
    }
  }
  return { noScm: false, ...onlyFailures }
}

/**
 * One project's files as the run selects them before the shard: the selection in place of the
 * file filters (Jest ignores path patterns in related mode), else the filters. `cache: false`
 * keeps the edge cache off too (`--no-cache`).
 * @internal
 */
export async function selectProjectFiles(
  project: ResolvedProject,
  everything: readonly DiscoveredFile[],
  options: {
    readonly selection: JestSelection
    readonly fileFilters: readonly FileFilter[]
    readonly cwd: string
    readonly cache: boolean
  },
): Promise<readonly DiscoveredFile[]> {
  const { selection } = options.selection
  if (selection === undefined) {
    return selectFiles(everything, options.fileFilters, {
      rootDir: project.rootDir,
      cwd: options.cwd,
    })
  }
  return selectAffected(
    { project, cacheProject: projectCacheKey(project) },
    everything,
    selection,
    options.cache ? cacheDirectories(project).results : null,
    undefined,
  )
}

/**
 * `--onlyFailures` over a project's files once they are sharded and sorted (`runJest.ts`
 * L300-L308): the files whose last run failed, from the results cache.
 * @internal
 */
export function keepFailedFiles<T extends DiscoveredFile>(
  project: ResolvedProject,
  files: readonly T[],
  cache: boolean,
): readonly T[] {
  const kept = keepFailed(
    {
      project,
      cacheProject: projectCacheKey(project),
      cache: cache ? createResultsCache(cacheDirectories(project).results) : undefined,
    },
    files,
    'history',
  )
  const keep = new Set(kept)
  return files.filter((file) => keep.has(file))
}
