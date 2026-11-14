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
 * The project's snapshot files with no test file, sorted (deleted under `all`), or `[]` when its
 * policy doesn't report them. A resolver that can't be built has already failed every file of the
 * project; its files are not crawled.
 */
export async function obsoleteSnapshotFiles(
  project: ObsoleteSnapshotProject,
  update: 'all' | 'new' | 'none',
): Promise<string[]> {
  const { snapshot } = project.policy
  if (snapshot.obsoleteFiles !== 'report') return []
  let resolveTestPath: (path: string) => string
  try {
    resolveTestPath = await testPathOf(project)
  } catch {
    return []
  }
  const { discovery } = project
  return cleanObsoleteSnapshotFiles({
    roots: discovery?.roots ?? [project.rootDir],
    extension: snapshot.extension,
    crawlIgnorePatterns: discovery?.crawlIgnorePatterns ?? [],
    testPathIgnorePatterns: discovery?.excludePatterns ?? [],
    testPathOf: resolveTestPath,
    update,
  })
}
