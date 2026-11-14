// T8.10, the coordinator's end of a coverage run: what the workers sent, merged; the files no test
// loaded, added with their initial coverage (Jest's CoverageReporter `_addUntestedFiles`); the
// whole map moved back to the sources (`_getCoverageResult`). The reports and thresholds read the
// result (`RunSummary.coverage`). Everything here loads only when a project collects coverage.
import type { ResolvedProject } from '@provino/config'
import {
  createCoverageFilter,
  loadCoverageReporting,
  loadInstrumenter,
} from '@provino/coverage/node'
import { serializeError } from '@provino/rpc'
import type {
  CoverageSummary,
  IstanbulFileCoverageData,
  SerializedProjectConfig,
} from '@provino/types'
import type { RawCoverageStore } from './coverage-store.ts'
import { crawlFiles } from './discover-rules.ts'

/**
 * What a run with coverage tells its caller about the files no test loaded.
 * @public
 */
export interface RunCoverageHooks {
  /**
   * Called before the first file no test loaded is covered, and after the last: a terminal gets a
   * notice meanwhile (Jest's `Running coverage on untested files...`). Not called when no file
   * matches the include globs.
   */
  readonly onUntested?: { readonly start: () => void; readonly end: () => void }
}

/** A project of the run, with its worker config (which holds its coverage config). */
type CoveredProject = Omit<ResolvedProject, 'config'> & { readonly config: SerializedProjectConfig }

/**
 * The files of `project` that its include globs name and its filter counts: the candidates for
 * coverage of a file no test loaded. Jest's `hasteFS.matchFilesWithGlob(collectCoverageFrom,
 * rootDir)` over its project's crawl, then `shouldInstrument`.
 */
async function untestedCandidates(project: CoveredProject): Promise<readonly string[]> {
  const coverage = project.config.coverage
  if (coverage === undefined || coverage.include.length === 0) return []
  if (!project.policy.coverage.includeUntestedByDefault) return []
  const { discovery } = project
  const files = await crawlFiles(
    discovery ?? {
      roots: [project.rootDir],
      extensions: project.config.loader.extensions.map((extension) => extension.replace(/^\./, '')),
      crawlIgnorePatterns: [],
    },
  )
  const counted = createCoverageFilter(coverage)
  return files.filter((path) => counted(path)).sort()
}

/**
 * Merges what the workers sent, adds the files no test loaded, remaps, and sums the run's coverage.
 * `projects` are the projects that ran a file, in the run's order: a file two of them name is
 * covered for the first.
 * @public
 */
export async function finishCoverage(
  store: RawCoverageStore,
  projects: readonly CoveredProject[],
  options: RunCoverageHooks = {},
): Promise<CoverageSummary> {
  const reporting = await loadCoverageReporting()
  const aggregate = reporting.createCoverageAggregate()
  for (const raw of store.entries) aggregate.add(raw)

  const untestedFailures: { path: string; error: ReturnType<typeof serializeError> }[] = []
  const candidates = await Promise.all(projects.map((project) => untestedCandidates(project)))
  const total = candidates.reduce((sum, list) => sum + list.length, 0)
  if (total > 0) {
    options.onUntested?.start()
    try {
      const seen = new Set<string>()
      for (const [index, project] of projects.entries()) {
        const paths = (candidates[index] ?? []).filter((path) => {
          if (seen.has(path) || aggregate.has(path)) return false
          seen.add(path)
          return true
        })
        if (paths.length === 0) continue
        await coverUntested(project, paths, aggregate.addUntested, untestedFailures)
      }
    } finally {
      options.onUntested?.end()
    }
  }

  const remapped = await reporting.remapCoverage(aggregate.map)
  const map = remapped.map.toJSON() as unknown as Record<string, IstanbulFileCoverageData>
  return {
    totals: reporting.coverageTotals(remapped.map),
    thresholdFailures: [],
    map,
    ...(untestedFailures.length === 0 ? {} : { untestedFailures }),
  }
}

/**
 * Each of `paths` through `project`'s transform with the instrumenter (the coordinator's own loader,
 * as a worker would load it), its initial coverage added. A file that fails is a failure of its
 * own, as Jest prints one and goes on.
 */
async function coverUntested(
  project: CoveredProject,
  paths: readonly string[],
  add: (data: IstanbulFileCoverageData) => void,
  failures: { path: string; error: ReturnType<typeof serializeError> }[],
): Promise<void> {
  const coverage = project.config.coverage
  if (coverage === undefined) return
  const [{ createCoordinatorLoader }, { istanbulInstrumenter, readInitialCoverage }] =
    await Promise.all([import('@provino/loader'), loadInstrumenter()])
  using loader = await createCoordinatorLoader(
    project.rootDir,
    project.config.loader,
    project.policy.module,
    {
      coverage: {
        instrumenter: istanbulInstrumenter({
          coverageVariable: project.policy.coverage.istanbulVariable,
        }),
        shouldInstrument: createCoverageFilter(coverage),
      },
    },
  )
  for (const path of paths) {
    try {
      const { code } = loader.transformForCoverage(path)
      const initial = readInitialCoverage(code)
      // `istanbul ignore file`: no coverage, as `generateEmptyCoverage` returns none.
      if (initial !== null) add(initial.coverageData)
    } catch (error) {
      failures.push({ path, error: serializeError(error) })
    }
  }
}
