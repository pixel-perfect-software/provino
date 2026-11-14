// T9.12, T9.16: what `RunProjectOptions.selection` and `onlyFailures` do to a project's files. Both
// are plain filters over the discovered files, so `run.ts` calls them and holds nothing else of
// this: selection in place of the file filters, `onlyFailures` after the shard (it commutes with
// the sort, which `planQueue` does).
import { join } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import type { AffectedSelection } from '@provino/types'
import type { ResultsCache } from '../cache.ts'
import type { DiscoveredFile } from '../discover.ts'
import { OrchestratorError } from '../errors.ts'
import { createAffectedIndex } from './index.ts'
import type { RecordedGraph } from './recorded.ts'

/** What `selectAffected` reads of a project of the run. */
export interface AffectedMember {
  readonly project: Pick<
    ResolvedProject,
    'rootDir' | 'discovery' | 'include' | 'exclude' | 'policy' | 'globalSetup' | 'config'
  > & { readonly cacheDirectory?: string | undefined }
  /** The results cache's key for the project. */
  readonly cacheProject: string
}

/**
 * The discovered files `selection` reaches: the tests related to some paths, or to the files a
 * change touched. It builds the project's index (its own coordinator loader resolves the edges) and
 * disposes the loader after. A selection by changed files needs `changed.changedFiles`; the paths
 * are absolute.
 */
export async function selectAffected(
  member: AffectedMember,
  everything: readonly DiscoveredFile[],
  selection: AffectedSelection,
  cacheDir: string | null,
  recorded: RecordedGraph | undefined,
): Promise<readonly DiscoveredFile[]> {
  const { project } = member
  const paths = selection.kind === 'related' ? selection.paths : selection.changed.changedFiles
  if (paths.length === 0) return []
  // The loader is the coordinator's engine for modules it imports itself; it is only loaded here.
  const { createCoordinatorLoader } = await import('@provino/loader')
  using loader = await createCoordinatorLoader(
    project.rootDir,
    project.config.loader,
    project.policy.module,
  )
  const index = await createAffectedIndex(project, {
    cacheDir,
    projectKey: member.cacheProject,
    loader,
    ...(recorded === undefined ? {} : { recorded }),
  })
  const related = new Set(index.related(paths))
  try {
    await index.save()
  } catch {
    // The cache is a convenience: an unwritable directory costs the next run its warm start.
  }
  return everything.filter((file) => related.has(join(project.rootDir, file.relativePath)))
}

/**
 * Keeps the files that failed: `'history'` reads the results cache (`FileHistory.failed`, a file
 * whose last run ended `fail`, as Jest's `FAIL` entry: a skipped file is never recorded), a set
 * names absolute paths.
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
