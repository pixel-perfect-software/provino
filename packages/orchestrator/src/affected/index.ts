// T9.12: the affected-test index of one project. One crawl of the project's roots, the specifiers of
// every file (through the edge cache), the edges resolved by the project's own loader, and the
// inverse: which test files a change reaches. The extractor, the mock edges, what a change to the
// project's own inputs selects and where the graph comes from are the policy's
// (`OrchestratorPolicy.affected`), so this code names no dialect.

import { statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ResolvedProject } from '@provino/config'
import { callBehaviour, createBehaviourLoader } from '@provino/policy'
import { testPathOfSnapshot } from '@provino/snapshot/node'
import type { ModuleRef } from '@provino/types'
import { crawlProject, type ProjectCrawl } from '../discover-rules.ts'
import { BATCH, byText, mapInBatches } from '../util.ts'
import { type EdgeCache, openEdgeCache } from './cache.ts'
import { type EdgeExtractor, hasEdges, loadExtractor } from './edges.ts'
import { projectInputs, touchesInputs } from './invalidate.ts'
import { type ReverseGraph, reachBackwards, reverseOf } from './inverse.ts'
import { freshDeps, type RecordedGraph } from './recorded.ts'
import { type DependencyResolver, indexMocks, type MockIndex, resolveEdges } from './resolve.ts'

/**
 * A change the watcher saw (or a caller found): what happened to which absolute path.
 * @beta
 */
export interface AffectedEvent {
  readonly kind: 'add' | 'change' | 'unlink'
  readonly path: string
}

/**
 * What an index is built from.
 * @beta
 */
export interface AffectedIndexOptions {
  /** The Provino cache directory (`cacheDirectories(project).results`): the edge cache is under `affected/`; `null` keeps nothing (`--no-cache`). */
  readonly cacheDir: string | null
  /** The results cache's key for the project: it names the cache file. */
  readonly projectKey: string
  /** The project's loader: how a specifier resolves. */
  readonly loader: DependencyResolver
  /** The project's own extractor (Jest's `dependencyExtractor`), read before the policy's. */
  readonly projectExtractor?: ModuleRef
  /** `watchPathIgnorePatterns`: regular expression sources the crawl leaves out. */
  readonly ignorePatterns?: readonly string[]
  /** The config file's path, which counts as a project input. */
  readonly configFile?: string
  /** The recorded graph (`affected.graph: 'recorded-then-static'`): what test files loaded last time. */
  readonly recorded?: RecordedGraph
}

/**
 * The tests a change reaches, for one project.
 * @beta
 */
export interface AffectedIndex {
  /**
   * The test files that `paths` (absolute) reach: the changed test files themselves and every test
   * whose closure holds a changed file, sorted. A changed `.snap` is its test file. A path outside
   * the project's roots reaches nothing; a change to one of the project's own inputs reaches every
   * test when the policy's `invalidateAll` says `project-inputs`.
   */
  related(paths: readonly string[]): readonly string[]
  /** A test file's direct dependencies, resolved (Jest's `findRelatedSourcesFromTestsInChangedFiles`). */
  sourcesOf(testPath: string): readonly string[]
  /** Applies what the watcher saw, then `related` answers for the new tree. */
  update(events: readonly AffectedEvent[]): Promise<void>
  /** Every crawled file and the test files among them. */
  files(): { readonly all: ReadonlySet<string>; readonly tests: readonly string[] }
  /** Writes the edge cache. */
  save(): Promise<void>
}

/**
 * The names of the files the edge cache and the recorded graph are written to.
 * @beta
 */
export function affectedCachePaths(
  cacheDir: string,
  projectKey: string,
): { readonly edges: string; readonly deps: string } {
  const safe = projectKey.replaceAll(/[^\w.-]/g, '_')
  return {
    edges: join(cacheDir, 'affected', `${safe}.json`),
    deps: join(cacheDir, 'affected', `deps-${safe}.json`),
  }
}

type IndexedProject = Pick<
  ResolvedProject,
  'rootDir' | 'discovery' | 'include' | 'exclude' | 'policy' | 'globalSetup' | 'config'
> & { readonly cacheDirectory?: string | undefined }

/** The mtime of a path in ms, or `undefined` for one that can't be read. */
function mtimeOfSync(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Builds the index of a project: crawls, reads and resolves every file once.
 * @beta
 */
export async function createAffectedIndex(
  project: IndexedProject,
  options: AffectedIndexOptions,
): Promise<AffectedIndex> {
  const { affected } = project.policy.orchestrator
  const crawl: ProjectCrawl = await crawlProject(project, {
    ...(options.ignorePatterns === undefined ? {} : { ignorePatterns: options.ignorePatterns }),
  })
  const extractor: EdgeExtractor = await loadExtractor(affected.extractor, options.projectExtractor)
  const cache: EdgeCache = await openEdgeCache(
    options.cacheDir === null
      ? null
      : affectedCachePaths(options.cacheDir, options.projectKey).edges,
    extractor.identity,
  )
  const inputs = projectInputs(
    project,
    options.configFile === undefined ? [] : [options.configFile],
  )
  const snapshotTestOf = await snapshotInverse(project, crawl)

  const files = new Set<string>(crawl.files)
  const tests = new Set<string>(crawl.files.filter((file) => crawl.isTest(file)))
  /** Each file's specifiers as written, kept so a change to the tree re-resolves without re-reading. */
  const specifiers = new Map<string, readonly string[]>()
  const edges = new Map<string, ReadonlySet<string>>()
  let mocks: MockIndex = indexMocks(files, affected.mockEdges)
  let staticReverse: ReverseGraph | undefined

  /** The file's specifiers: from the cache when its mtime and size are what they were, else read. */
  async function specifiersOf(file: string): Promise<readonly string[] | undefined> {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(file)
    } catch {
      return undefined
    }
    const cached = cache.get(file, info.mtimeMs, info.size)
    if (cached !== undefined) return cached
    let code: string
    try {
      code = await readFile(file, 'utf8')
    } catch {
      return undefined
    }
    let found: readonly string[]
    try {
      found = extractor.extract(code, file)
    } catch {
      // A file the extractor can't read has no edges we can see.
      found = []
    }
    cache.set(file, info.mtimeMs, info.size, found)
    return found
  }

  function resolveFile(file: string): void {
    const listed = specifiers.get(file)
    if (listed === undefined) edges.delete(file)
    else {
      edges.set(
        file,
        resolveEdges(file, listed, {
          resolver: options.loader,
          mocks,
          mockEdges: affected.mockEdges,
        }),
      )
    }
  }

  await mapInBatches(crawl.files.filter(hasEdges), BATCH, async (file) => {
    const found = await specifiersOf(file)
    if (found !== undefined) specifiers.set(file, found)
  })
  for (const file of specifiers.keys()) resolveFile(file)

  /**
   * The graph a call reads: the static reverse index, and the tests whose record is fresh. A test
   * with a fresh record is selected by what it loaded (`loaded`), not by the sources' edges, so its
   * own edges are left out of the walk (a source it never loaded can't reach it).
   */
  function graph(): {
    readonly reverse: ReverseGraph
    readonly loaded: ReadonlyMap<string, ReadonlySet<string>>
  } {
    const recorded = options.recorded
    staticReverse ??= reverseOf(edges)
    const none = { reverse: staticReverse, loaded: new Map() }
    if (affected.graph !== 'recorded-then-static' || recorded === undefined) return none
    const mtimes = new Map<string, number | undefined>()
    const mtimeOf = (path: string): number | undefined => {
      if (!mtimes.has(path)) mtimes.set(path, mtimeOfSync(path))
      return mtimes.get(path)
    }
    const loaded = new Map<string, ReadonlySet<string>>()
    for (const test of tests) {
      const deps = freshDeps(recorded, test, mtimeOf)
      if (deps !== undefined) loaded.set(test, new Set([test, ...deps]))
    }
    if (loaded.size === 0) return none
    const effective = new Map(edges)
    for (const test of loaded.keys()) effective.delete(test)
    return { reverse: reverseOf(effective), loaded }
  }

  function related(changed: readonly string[]): readonly string[] {
    const absolute = changed.map((path) => resolve(path))
    if (affected.invalidateAll === 'project-inputs' && touchesInputs(absolute, inputs)) {
      return [...tests].sort(byText)
    }
    const seeds: string[] = []
    for (const path of absolute) {
      const owner = snapshotTestOf(path)
      const seed = owner ?? path
      if (files.has(seed)) seeds.push(seed)
    }
    const { reverse, loaded } = graph()
    const reached = reachBackwards(seeds, reverse, (file) => tests.has(file) && !loaded.has(file))
    for (const [test, modules] of loaded) {
      if (seeds.some((seed) => modules.has(seed))) reached.add(test)
    }
    return [...reached].sort(byText)
  }

  return {
    related,
    sourcesOf: (testPath) => [...(edges.get(resolve(testPath)) ?? [])],
    async update(events) {
      let shape = false
      const changed: string[] = []
      for (const { kind, path } of events) {
        if (kind === 'change') {
          if (specifiers.has(path)) changed.push(path)
          continue
        }
        // A file that comes or goes can resolve (or stop resolving) other files' specifiers, and a
        // mock directory entry changes the mock index.
        shape = true
        if (kind === 'unlink') {
          files.delete(path)
          tests.delete(path)
          specifiers.delete(path)
          edges.delete(path)
        } else if (!files.has(path)) {
          files.add(path)
          if (crawl.isTest(path)) tests.add(path)
          changed.push(path)
        }
      }
      await mapInBatches(changed, BATCH, async (file) => {
        if (!hasEdges(file)) return
        const found = await specifiersOf(file)
        if (found === undefined) specifiers.delete(file)
        else specifiers.set(file, found)
      })
      if (shape) {
        options.loader.invalidateResolution?.(events.map((event) => event.path))
        mocks = indexMocks(files, affected.mockEdges)
        for (const file of specifiers.keys()) resolveFile(file)
      } else {
        for (const file of changed) resolveFile(file)
      }
      staticReverse = undefined
    },
    files: () => ({ all: files, tests: [...tests].sort(byText) }),
    save: () => cache.save(),
  }
}

/**
 * Which test file a `.snap` path belongs to: the inverse of the default layout, or, for a project
 * with a snapshot path resolver of its own, the resolver asked forwards for every test file.
 */
async function snapshotInverse(
  project: IndexedProject,
  crawl: ProjectCrawl,
): Promise<(path: string) => string | undefined> {
  const { snapshot } = project.policy
  if (snapshot.resolvePath === null) {
    return (path) => testPathOfSnapshot(path, snapshot)
  }
  const behaviours = createBehaviourLoader()
  const owners = new Map<string, string>()
  for (const file of crawl.files) {
    if (!crawl.isTest(file)) continue
    const snap = await callBehaviour(behaviours, snapshot.resolvePath, file, snapshot.extension)
    owners.set(snap, file)
  }
  return (path) => owners.get(path)
}
