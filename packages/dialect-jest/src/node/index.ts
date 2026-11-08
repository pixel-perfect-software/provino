// @provino/dialect-jest/node: the Jest dialect's coordinator half (B14b). The config reader:
// find (T11.3), load (T11.4), presets (T11.5), normalize and the neutral projects (T11.6), each a
// rebuild of `jest-config` 30.5.2 checked against it. `jestNodeDialect` is `jestDialect` with the
// reader; `.` can't import this entry (the manifest has `/node` depending on `.`), so the reader
// lives on this value. The CLI flags are T11.7's (B14c).

import { jestDialect } from '@provino/dialect-jest'
import type {
  ConfigReader,
  ConfigSource,
  Diagnostic,
  Dialect,
  NeutralProject,
} from '@provino/types'
import { JestConfigError } from './errors.ts'
import { findJestConfig, JEST_CONFIG_CANDIDATES } from './find.ts'
import { loadJestConfig } from './load.ts'
import { type NormalizeOptions, normalizeLoadedJestConfig, readJestConfigs } from './normalize.ts'
import { jestProjectToNeutral } from './to-neutral.ts'
import type { JestGlobalConfig, JestInitialOptions, JestProjectConfig } from './types.ts'

export { JestConfigError, type JestConfigErrorCode } from './errors.ts'
export {
  findJestConfig,
  isJSONString,
  JEST_CONFIG_CANDIDATES,
  JEST_CONFIG_EXT_ORDER,
  resolveJestConfigPath,
} from './find.ts'
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
  JestMapperEntry,
  JestProjectConfig,
  JestReadConfig,
  JestReporterEntry,
  JestTransformEntry,
} from './types.ts'
export { type ValidationOutcome, validateJestConfig } from './validate.ts'

/**
 * What the reader's `load` step returns: the file's options with `rootDir` set, and its path
 * (`null` for inline JSON).
 * @public
 */
export interface JestLoadedConfig {
  readonly options: JestInitialOptions
  readonly configPath: string | null
}

/**
 * What the reader's `resolve` step returns: the run's global config and each project's config
 * (one, or one per entry of `projects`).
 * @public
 */
export interface JestResolvedConfig {
  readonly globalConfig: JestGlobalConfig
  readonly configs: readonly JestProjectConfig[]
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
      const cwd = options.cwd ?? process.cwd()
      const root = await normalizeLoadedJestConfig(raw, options)
      const read = await readJestConfigs(
        [source.kind === 'inline' ? cwd : source.path],
        options,
        root,
      )
      return {
        value: { globalConfig: read.globalConfig, configs: read.configs },
        diagnostics: read.diagnostics,
      }
    },
    toNeutral(resolved: JestResolvedConfig) {
      const diagnostics: Diagnostic[] = []
      const value: NeutralProject[] = resolved.configs.map((config) => {
        const neutral = jestProjectToNeutral(config, resolved.globalConfig)
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
 * The Jest 30.5 dialect with its config reader: what the coordinator uses. `jestDialect` (`.`) is
 * the same value without it, for code that runs in a worker.
 * @public
 */
export const jestNodeDialect: Dialect<'jest'> = {
  ...jestDialect,
  configReader: jestConfigReader,
}
