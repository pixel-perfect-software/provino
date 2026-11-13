// @provino/dialect-jest/node: the Jest dialect's coordinator half (B14b). The config reader:
// find (T11.3), load (T11.4), presets (T11.5), normalize and the neutral projects (T11.6), each a
// rebuild of `jest-config` 30.5.2 checked against it. `jestNodeDialect` is `jestDialect` with the
// reader; `.` can't import this entry (the manifest has `/node` depending on `.`), so the reader
// lives on this value. The same goes for the command line (T11.7, B14c): `jestCli` parses Jest's
// flags, `jestFlags` lists them.

import { jestDialect } from '@provino/dialect-jest'
import type {
  ConfigReader,
  ConfigSource,
  Diagnostic,
  Dialect,
  NeutralProject,
} from '@provino/types'
import { jestCli, jestFlags } from './cli.ts'
import { JestConfigError } from './errors.ts'
import { findJestConfig, JEST_CONFIG_CANDIDATES } from './find.ts'
import { loadJestConfig } from './load.ts'
import { type NormalizeOptions, readJestConfigs } from './normalize.ts'
import { jestProjectToNeutral } from './to-neutral.ts'
import type { JestGlobalConfig, JestLoadedConfig, JestProjectConfig } from './types.ts'

export * from '@provino/dialect-jest/results'
export {
  JEST_CLI_OPTIONS,
  type JestCliOption,
  type JestCliSupport,
  jestArgvToRunRequest,
  jestCli,
  jestFlags,
  parseJestArgv,
  parseJestCli,
} from './cli.ts'
export {
  JestCliError,
  type JestCliErrorCode,
  JestConfigError,
  type JestConfigErrorCode,
} from './errors.ts'
export {
  findJestConfig,
  isJSONString,
  JEST_CONFIG_CANDIDATES,
  JEST_CONFIG_EXT_ORDER,
  resolveJestConfigPath,
} from './find.ts'
export { jestRunGlobalHooks } from './global-hooks.ts'
export { inlineProjectOptions, loadJestConfig, readJestConfigFile } from './load.ts'
export {
  groupJestOptions,
  type JestReadConfigsOutcome,
  type JestReadOutcome,
  jestDefaults,
  type NormalizedJestOptions,
  type NormalizeOptions,
  normalizeJestConfig,
  normalizeLoadedJestConfig,
  type ReadJestConfigOptions,
  readJestConfig,
  readJestConfigs,
} from './normalize.ts'
export { replaceRootDirInPath } from './paths.ts'
export { setupPreset } from './preset.ts'
export { type CollectedTextStyle, jestCollectedText } from './reporters/collected-text.ts'
export {
  createJestReporterHost,
  type JestLoadedReporter,
  type JestReporterClass,
  type JestReporterContext,
  type JestReporterHostOptions,
  type JestReporterInstance,
  type JestReporterOnStartOptions,
} from './reporters/host.ts'
export { loadJestReporters } from './reporters/load.ts'
export {
  type JestReporterEnvironment,
  type JestReporterPlan,
  type JestReporterStep,
  jestReporterPlan,
} from './reporters/plan.ts'
export {
  type ProcessJestResultsOptions,
  processJestResults,
} from './reporters/process-results.ts'
export {
  jestRunSummaryLine,
  jestSnapshotStatus,
  jestSnapshotSummary,
  jestUpdateCommand,
} from './reporters/summary-text.ts'
export {
  createJestResolution,
  type FindNodeModuleOptions,
  type JestRequireResolve,
  type JestResolution,
  projectJestRequireResolve,
} from './resolution.ts'
export { jestProjectToNeutral, neutralEnvironmentName } from './to-neutral.ts'
export type {
  JestArgv,
  JestDisplayName,
  JestGlobalConfig,
  JestInitialOptions,
  JestLoadedConfig,
  JestMapperEntry,
  JestProjectConfig,
  JestReadConfig,
  JestReporterEntry,
  JestTransformEntry,
} from './types.ts'
export { type ValidationOutcome, validateJestConfig } from './validate.ts'

/**
 * What the reader's `resolve` step returns: the run's global config and each project's config
 * (one, or one per entry of `projects`).
 * @public
 */
export interface JestResolvedConfig {
  readonly globalConfig: JestGlobalConfig
  readonly configs: readonly JestProjectConfig[]
  /** Per config, whether it named a `cacheDirectory` (D70). Absent: none did. */
  readonly cacheDirectorySet?: readonly boolean[]
}

/**
 * The Jest config reader for a working directory and normalize options (`cwd` defaults to
 * `process.cwd()`).
 * @public
 */
export function createJestConfigReader(
  options: NormalizeOptions = {},
): ConfigReader<JestLoadedConfig, JestResolvedConfig> {
  return {
    candidates: JEST_CONFIG_CANDIDATES,
    async find(cwd: string, explicit?: string): Promise<ConfigSource | undefined> {
      try {
        return findJestConfig(cwd, explicit)
      } catch (error) {
        if (
          explicit === undefined &&
          error instanceof JestConfigError &&
          error.code === 'JEST_CONFIG_NOT_FOUND'
        ) {
          return undefined
        }
        throw error
      }
    },
    load(source: ConfigSource): Promise<JestLoadedConfig> {
      return loadJestConfig(source)
    },
    async resolve(raw: JestLoadedConfig, source: ConfigSource) {
      // Inline JSON (`--config '{…}'`) belongs to the directory `find` was given, which is where
      // its `projects` globs, `rootDir` and the projects' parent directory resolve; Jest reads it
      // again for each project, as `argv.config`. A file is read where `jest` runs.
      const inline = source.kind === 'inline'
      const cwd = inline ? source.path : (options.cwd ?? process.cwd())
      const read = await readJestConfigs(
        [source.path],
        {
          ...options,
          cwd,
          ...(inline ? { argv: { ...options.argv, config: source.text } } : {}),
        },
        raw,
      )
      return {
        value: {
          globalConfig: read.globalConfig,
          configs: read.configs,
          cacheDirectorySet: read.cacheDirectorySet,
        },
        diagnostics: read.diagnostics,
      }
    },
    toNeutral(resolved: JestResolvedConfig) {
      const diagnostics: Diagnostic[] = []
      const value: NeutralProject[] = resolved.configs.map((config, index) => {
        const neutral = jestProjectToNeutral(config, resolved.globalConfig, {
          cacheDirectorySet: resolved.cacheDirectorySet?.[index] ?? false,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.requireResolve === undefined
            ? {}
            : { requireResolve: options.requireResolve }),
        })
        diagnostics.push(...neutral.diagnostics)
        return neutral.project
      })
      return { value, diagnostics }
    },
  }
}

/**
 * The Jest config reader with the defaults: the process's working directory, no CLI values, and
 * Jest's own packages found through the project's Jest.
 * @public
 */
export const jestConfigReader: ConfigReader<JestLoadedConfig, JestResolvedConfig> =
  createJestConfigReader()

/**
 * The Jest 30.5 dialect with its config reader and command line: what the coordinator uses.
 * `jestDialect` (`.`) is the same value without them, for code that runs in a worker.
 * @public
 */
export const jestNodeDialect: Dialect<'jest'> = {
  ...jestDialect,
  configReader: jestConfigReader,
  cli: jestCli,
  flags: jestFlags,
}
