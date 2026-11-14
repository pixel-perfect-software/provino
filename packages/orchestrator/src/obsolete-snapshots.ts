// A project's obsolete snapshot files (B23d B1, DV96), after its files ran, when its policy
// reports them (`snapshot.obsoleteFiles`): the crawl and the inverse are `@provino/snapshot/node`'s;
// this module finds the project's roots, ignore patterns and resolver. A project that names its
// own snapshot resolver has it loaded in the coordinator through the project's transform (the
// loader in coordinator mode, as global setup has it), as Jest's `TestScheduler` builds one.
import { createBehaviourLoader } from '@provino/policy'
import { cleanObsoleteSnapshotFiles, defaultSnapshotTestPath } from '@provino/snapshot/node'
import type { NeutralDiscovery, Policy, SerializedProjectConfig } from '@provino/types'

/** What the cleanup reads of a project. */
export interface ObsoleteSnapshotProject {
  readonly rootDir: string
  readonly policy: Policy
  readonly discovery: NeutralDiscovery | null
  readonly config: Pick<SerializedProjectConfig, 'snapshotResolver' | 'loader'>
}

/** The test file of each snapshot file: the layout's inverse, or the project resolver's. */
async function testPathOf(project: ObsoleteSnapshotProject): Promise<(path: string) => string> {
  const { snapshot } = project.policy
  const module = project.config.snapshotResolver
  if (module === undefined || snapshot.resolverFactory === null) {
    return (path) => defaultSnapshotTestPath(path, snapshot)
  }
  const factory = await createBehaviourLoader().load(snapshot.resolverFactory)
  const { createCoordinatorLoader } = await import('@provino/loader')
  const loader = await createCoordinatorLoader(
    project.rootDir,
    project.config.loader,
    project.policy.module,
  )
  try {
    const resolver = factory(await loader.import(module), snapshot.extension)
    return (path) => resolver.resolveTestPath(path)
  } finally {
    loader.dispose()
  }
}

/**
 * The project's cleanup of snapshot files with no test file: the project's resolver is built here
 * (a project that names one has it loaded), and the function it returns crawls, sorts and, under
 * `all`, deletes them. A policy that doesn't report them gets a cleanup that finds none.
 *
 * **A resolver that can't be built rejects**, with its own error, as Jest's does: `TestScheduler`'s
 * `updateSnapshotState` builds every project's resolver before it cleans any (`Promise.all`,
 * L205-L211, the throw escaping `scheduleTests`: the run prints the error and ends, with no totals
 * and no file cleaned). The caller builds all of them first for the same reason.
 */
export async function prepareObsoleteSnapshotCleanup(
  project: ObsoleteSnapshotProject,
  update: 'all' | 'new' | 'none',
): Promise<() => string[]> {
  const { snapshot } = project.policy
  if (snapshot.obsoleteFiles !== 'report') return () => []
  const resolveTestPath = await testPathOf(project)
  const { discovery } = project
  return () =>
    cleanObsoleteSnapshotFiles({
      roots: discovery?.roots ?? [project.rootDir],
      extension: snapshot.extension,
      crawlIgnorePatterns: discovery?.crawlIgnorePatterns ?? [],
      testPathIgnorePatterns: discovery?.excludePatterns ?? [],
      testPathOf: resolveTestPath,
      update,
    })
}
