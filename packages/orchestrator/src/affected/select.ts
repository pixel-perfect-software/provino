// T9.12, T9.16: what `RunProjectOptions.selection` and `onlyFailures` do to a project's files. Both
// are plain filters over the discovered files, so `run.ts` calls them and holds nothing else of
// this: selection in place of the file filters, `onlyFailures` after the shard (it commutes with
// the sort, which `planQueue` does).
import { join } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import { callBehaviour, createBehaviourLoader } from '@provino/policy'
import type {
  AffectedSelection,
  Behaviour,
  ChangedFiles,
  ChangedFilesOptions,
  ChangedFilesProvider,
} from '@provino/types'
import type { ResultsCache } from '../cache.ts'
import type { DiscoveredFile } from '../discover.ts'
import { OrchestratorError } from '../errors.ts'
import { createAffectedIndex } from './index.ts'
import type { RecordedGraph } from './recorded.ts'

/**
 * What `selectAffected` reads of a project of the run.
 * @beta
 */
export interface AffectedMember {
  readonly project: Pick<
    ResolvedProject,
    'rootDir' | 'discovery' | 'include' | 'exclude' | 'policy' | 'globalSetup' | 'config'
  > & {
    readonly cacheDirectory?: string | undefined
    readonly affected?: ResolvedProject['affected'] | undefined
  }
  /** The results cache's key for the project. */
  readonly cacheProject: string
}

/**
 * What one index build answers for a selection: the absolute paths of the files it reaches, and,
 * for a selection by changed files, the sources the changed test files import (Jest's
 * `findRelatedSourcesFromTestsInChangedFiles`, SearchSource L361-L379: the direct dependencies of
 * each changed file that is a test file of the project; empty when none is).
 * @beta
 */
export interface AffectedLookup {
  readonly related: ReadonlySet<string>
  readonly sources: readonly string[]
}

/**
 * The seams of a lookup; a test counts index builds through `createIndex`.
 * @beta
 */
export interface AffectedLookupOptions {
  readonly createIndex?: typeof createAffectedIndex
}

/**
 * Builds the project's index once (its own coordinator loader resolves the edges, disposed after)
 * and reads from it everything a selection and the changed-file coverage need, so a run that asks
 * for both builds one index. A selection by changed files needs `changed.changedFiles`; the paths
 * are absolute. With no path nothing is built.
 * @beta
 */
export async function lookupAffected(
  member: AffectedMember,
  selection: AffectedSelection,
  cacheDir: string | null,
  recorded: RecordedGraph | undefined,
  options: AffectedLookupOptions = {},
): Promise<AffectedLookup> {
  const { project } = member
  const paths = selection.kind === 'related' ? selection.paths : selection.changed.changedFiles
  if (paths.length === 0) return { related: new Set(), sources: [] }
  // The loader is the coordinator's engine for modules it imports itself; it is only loaded here.
  const { createCoordinatorLoader } = await import('@provino/loader')
  // No `using`: Node 22.15, the floor, cannot parse it.
  const loader = await createCoordinatorLoader(
    project.rootDir,
    project.config.loader,
    project.policy.module,
  )
  try {
    const index = await (options.createIndex ?? createAffectedIndex)(project, {
      cacheDir,
      projectKey: member.cacheProject,
      loader,
      ...(recorded === undefined ? {} : { recorded }),
      // The project's own extractor (Jest's `dependencyExtractor`); a run that isn't a watch reads
      // no `watchPathIgnorePatterns` (jest-runtime `createHasteMap` L333-L337).
      ...(project.affected?.extractor === undefined
        ? {}
        : { projectExtractor: project.affected.extractor }),
    })
    const related = new Set(index.related(paths))
    const sources = new Set<string>()
    if (selection.kind === 'changed') {
      const tests = new Set(index.files().tests)
      for (const path of paths) {
        if (!tests.has(path)) continue
        for (const source of index.sourcesOf(path)) sources.add(source)
      }
    }
    try {
      await index.save()
    } catch {
      // The cache is a convenience: an unwritable directory costs the next run its warm start.
    }
    return { related, sources: [...sources] }
  } finally {
    loader[Symbol.dispose]()
  }
}

/**
 * The discovered files `selection` reaches: the tests related to some paths, or to the files a
 * change touched. It builds the project's index through `lookupAffected`, unless the caller passes
 * the `lookup` it already made.
 * @beta
 */
export async function selectAffected(
  member: AffectedMember,
  everything: readonly DiscoveredFile[],
  selection: AffectedSelection,
  cacheDir: string | null,
  recorded: RecordedGraph | undefined,
  lookup?: AffectedLookup,
): Promise<readonly DiscoveredFile[]> {
  const { related } = lookup ?? (await lookupAffected(member, selection, cacheDir, recorded))
  if (related.size === 0) return []
  return everything.filter((file) => related.has(join(member.project.rootDir, file.relativePath)))
}

/**
 * Keeps the files that failed: `'history'` reads the results cache (`FileHistory.failed`, a file
 * whose last run ended `fail`, as Jest's `FAIL` entry: a skipped file is never recorded), a set
 * names absolute paths.
 * @beta
 */
export function keepFailed(
  member: AffectedMember & { readonly cache: ResultsCache | undefined },
  files: readonly DiscoveredFile[],
  onlyFailures: 'history' | ReadonlySet<string>,
): readonly DiscoveredFile[] {
  if (onlyFailures === 'history') {
    if (member.cache === undefined) {
      throw new OrchestratorError(
        'ORCH_BAD_OPTION',
        'onlyFailures: "history" needs the results cache, and this run has none (--no-cache)',
      )
    }
    const { cache, cacheProject } = member
    return files.filter((file) => cache.get(cacheProject, file.relativePath)?.failed === true)
  }
  return files.filter((file) => onlyFailures.has(join(member.project.rootDir, file.relativePath)))
}

/**
 * The files a change touched under some roots, by the policy's `orchestrator.changedFiles` (Jest's
 * jest-changed-files under the Jest dialect). A policy with none can't select by changed files:
 * `ORCH_NOT_IMPLEMENTED`, naming the task that builds the neutral and Vitest ones. What the
 * provider rejects with (a failing git command) is passed on as it is.
 * @beta
 */
export async function findChangedFiles(
  provider: Behaviour<ChangedFilesProvider> | null,
  options: ChangedFilesOptions,
): Promise<ChangedFiles> {
  if (provider === null) {
    throw new OrchestratorError(
      'ORCH_NOT_IMPLEMENTED',
      'selecting tests by changed files is not built for this dialect yet',
    )
  }
  return callBehaviour(createBehaviourLoader(), provider, options)
}

/**
 * Whether a change set came from any repository: Jest's `hasSCM` (SearchSource L42-L44). With
 * none, `-o` selects nothing and Jest says why.
 * @beta
 */
export function hasScm(changed: ChangedFiles): boolean {
  const { git, hg, sl } = changed.repos
  return git.length + hg.length + sl.length > 0
}
