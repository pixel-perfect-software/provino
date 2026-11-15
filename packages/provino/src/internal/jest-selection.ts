// `provino jest`'s changed-file flags (B23c, T9.16): which test files Jest 30.5.2 selects, as
// SearchSource `_getTestPaths` L269-L305 and `runJest` L254-L308 decide it, over the orchestrator's
// primitives. Read from the reader's merged global config, never the raw argv: `-o` comes on with
// `--changedSince`, `--lastCommit` and `--changedFilesWithAncestor`, and off with `--all` or a path
// pattern (jest-config `normalize.ts` L1114-L1154).
import { resolve } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import type { JestGlobalConfig, JestProjectConfig } from '@provino/dialect-jest/node'
import {
  type AffectedLookup,
  type AffectedLookupOptions,
  cacheDirectories,
  createResultsCache,
  type DiscoveredFile,
  findChangedFiles,
  hasScm,
  keepFailed,
  lookupAffected,
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
  /**
   * One affected lookup per project, made by whichever of the selection and the changed-file
   * coverage asks first and read by the other (one index build, D115). Keyed by the project
   * object; `withChangedCoverage` registers the copies it makes.
   */
  readonly lookups: WeakMap<ResolvedProject, Promise<AffectedLookup>>
  /** The seam a test counts index builds through. */
  readonly lookupOptions?: AffectedLookupOptions
}

function lookupFor(
  selection: JestSelection,
  project: ResolvedProject,
  affected: AffectedSelection,
  cache: boolean,
): Promise<AffectedLookup> {
  let lookup = selection.lookups.get(project)
  if (lookup === undefined) {
    lookup = lookupAffected(
      { project, cacheProject: projectCacheKey(project) },
      affected,
      cache ? cacheDirectories(project).results : null,
      undefined,
      selection.lookupOptions,
    )
    selection.lookups.set(project, lookup)
  }
  return lookup
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
  lookupOptions?: AffectedLookupOptions,
): Promise<JestSelection> {
  const onlyFailures = globalConfig.onlyFailures ? ({ onlyFailures: 'history' } as const) : {}
  const [first] = projects
  const lookupExtra = lookupOptions === undefined ? {} : { lookupOptions }
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
      lookups: new WeakMap(),
      ...lookupExtra,
      ...onlyFailures,
    }
  }
  const paths = globalConfig.nonFlagArgs
  if (!globalConfig.runTestsByPath && globalConfig.findRelatedTests && paths.length > 0) {
    return {
      selection: { kind: 'related', paths: paths.map((path) => resolve(cwd, path)) },
      noScm: false,
      lookups: new WeakMap(),
      ...lookupExtra,
      ...onlyFailures,
    }
  }
  return { noScm: false, lookups: new WeakMap(), ...lookupExtra, ...onlyFailures }
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
  const lookup = await lookupFor(options.selection, project, selection, options.cache)
  return selectAffected(
    { project, cacheProject: projectCacheKey(project) },
    everything,
    selection,
    null,
    undefined,
    lookup,
  )
}

/**
 * `--onlyFailures` over a project's files once they are sharded and sorted (`runJest.ts`
 * L300-L308): the files whose last run failed, from the results cache. Under `--no-cache` there is
 * no history to read, so none is kept: jest-test-sequencer reads its perf cache only when
 * `config.cache` is on (`_getCache`, L67-L79), and `allFailedTests` finds nothing.
 * @internal
 */
export function keepFailedFiles<T extends DiscoveredFile>(
  project: ResolvedProject,
  files: readonly T[],
  cache: boolean,
): readonly T[] {
  if (!cache) return []
  const kept = keepFailed(
    {
      project,
      cacheProject: projectCacheKey(project),
      cache: createResultsCache(cacheDirectories(project).results),
    },
    files,
    'history',
  )
  const keep = new Set(kept)
  return files.filter((file) => keep.has(file))
}

/**
 * What `shouldRunTestSuite` is given as `duration` (`runJest.ts` L149-L157: `test.duration`, the
 * time the file took last run, from the sequencer's perf cache): the results cache's `durationMs`,
 * the history `--onlyFailures` and the sequencer read; `undefined` with no history, and always
 * under `--no-cache` (Jest reads its cache only when `config.cache` is on).
 * @internal
 */
export function previousDurations(
  project: ResolvedProject,
  cache: boolean,
): (path: string) => number | undefined {
  if (!cache) return () => undefined
  const results = createResultsCache(cacheDirectories(project).results)
  const key = projectCacheKey(project)
  return (path) => results.get(key, path)?.durationMs
}

/**
 * Whether an error is a command the changed-files provider ran that failed (`exec.ts`'s
 * `JEST_SCM_COMMAND_FAILED`): what Jest prints in red, with no stack, and exits 1 for
 * (`getChangedFilesPromise.ts` L28-L37). Any other error is internal and keeps its stack.
 * @internal
 */
export function isScmCommandFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { readonly code?: unknown }).code === 'JEST_SCM_COMMAND_FAILED'
  )
}

/**
 * `-o` and coverage (`runJest.ts` L403-L421): the run counts only the changed files and the
 * sources the changed test files import (`shouldInstrument` L111-L118). Each project's coverage
 * config gets both lists, the related sources taken across every project's index as one set. Jest
 * computes them on every `-o` run; they matter only when coverage is on, so nothing is built
 * without it (speed, D115). Projects with no coverage config are returned as they are.
 * @internal
 */
export async function withChangedCoverage(
  projects: readonly ResolvedProject[],
  selection: JestSelection,
  cache: boolean,
): Promise<readonly ResolvedProject[]> {
  if (selection.selection?.kind !== 'changed') return projects
  const { changedFiles } = selection.selection.changed
  const related = new Set<string>()
  for (const project of projects) {
    if (project.config.coverage === undefined) continue
    const lookup = await lookupFor(selection, project, selection.selection, cache)
    for (const source of lookup.sources) related.add(source)
  }
  return projects.map((project) => {
    if (project.config.coverage === undefined) return project
    const restricted: ResolvedProject = {
      ...project,
      config: {
        ...project.config,
        coverage: {
          ...project.config.coverage,
          changedFiles,
          sourcesRelatedToTestsInChangedFiles: [...related],
        },
      },
    }
    // The selection runs on the copy: it reads the lookup made here.
    const lookup = selection.lookups.get(project)
    if (lookup !== undefined) selection.lookups.set(restricted, lookup)
    return restricted
  })
}
