// The top-level `coverage` key (B28, D212): its defaults applied, and each project's worker-side
// coverage config built from it. The run has one report directory, one reporter set and one
// threshold set, so the key belongs to the top-level config, and every project counts the same files.
import { isAbsolute, join, resolve } from 'node:path'
import type {
  ConfigCoverage,
  CoverageReporterName,
  CoverageThresholdGroup,
  JsonValue,
  SerializedCoverageConfig,
} from '@provino/types'
import type { ResolvedProject } from './resolve.ts'

/**
 * The run's coverage settings with their defaults applied. `enabled` says whether the config asks
 * for coverage; `--coverage` asks too, and the caller merges the two.
 * @public
 */
export interface ResolvedCoverage {
  readonly enabled: boolean
  readonly provider: 'v8' | 'istanbul'
  /** Globs relative to the run's root; none means every file the tests load. */
  readonly include: readonly string[]
  /** Globs relative to the run's root. */
  readonly exclude: readonly string[]
  readonly reporters: readonly (readonly [
    CoverageReporterName,
    Readonly<Record<string, JsonValue>>,
  ])[]
  /** Absolute. */
  readonly directory: string
  /** The threshold groups, in the config's order. */
  readonly thresholds: readonly CoverageThresholdGroup[]
}

/**
 * Applies the defaults to a parsed `coverage` key: provider `v8` (no instrumentation), reporters
 * `text` and `lcovonly` (no HTML pages unless asked), `**\/node_modules/**` excluded (V8's own
 * filter has no `node_modules` step), and the report directory the policy names (`reportsDirectory`)
 * under `runRoot`. All of those are speed choices. `directory` is made absolute against `runRoot`.
 * @internal
 */
export function resolveCoverage(
  coverage: ConfigCoverage | undefined,
  runRoot: string,
  reportsDirectory: string,
): ResolvedCoverage {
  return {
    enabled: coverage?.enabled === true,
    provider: coverage?.provider ?? 'v8',
    include: coverage?.include ?? [],
    exclude: coverage?.exclude ?? ['**/node_modules/**'],
    reporters: (coverage?.reporters ?? ['text', 'lcovonly']).map((entry) =>
      typeof entry === 'string' ? [entry, {}] : [entry[0], entry[1]],
    ),
    directory: resolve(runRoot, coverage?.directory ?? reportsDirectory),
    thresholds: Object.entries(coverage?.thresholds ?? {}).map(([name, group]) => ({
      name,
      ...group,
    })),
  }
}

/** A project's include glob as the absolute-path glob the coverage filter tests files against. */
function absoluteGlob(rootDir: string, glob: string): string {
  return glob.startsWith('!') ? `!${join(rootDir, glob.slice(1))}` : join(rootDir, glob)
}

/**
 * `projects` with each worker told to collect `coverage` (a run that collects it): the provider,
 * the include and exclude globs against `runRoot`, and which files are tests (the project's own
 * include globs, which never count) and setup files (which never count either, with `configPath`).
 * Only strings and arrays cross to the worker. The projects it is given are left alone.
 * @public
 */
export function withCoverage(
  projects: readonly ResolvedProject[],
  coverage: ResolvedCoverage,
  runRoot: string,
  configPath?: string,
): readonly ResolvedProject[] {
  return projects.map((project): ResolvedProject => {
    const serialized: SerializedCoverageConfig = {
      provider: coverage.provider,
      globalRoot: runRoot,
      projectRoot: project.rootDir,
      include: [...coverage.include],
      includeRoot: true,
      force: [],
      testFiles: project.include.map((glob) => absoluteGlob(project.rootDir, glob)),
      testRegex: [],
      testIgnorePatterns: [],
      excludePatterns: [],
      excludeGlobs: [...coverage.exclude],
      excludePaths: [
        ...(configPath === undefined ? [] : [configPath]),
        ...project.config.setupFiles,
        ...project.config.setupFilesAfterEnv,
      ].filter((path) => isAbsolute(path)),
    }
    return { ...project, config: { ...project.config, coverage: serialized } }
  })
}
