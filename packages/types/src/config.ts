// Track 1 §Config at v0. T1.4 (@provino/config) adds defineConfig, loading and validation, and
// the keys each feature needs.
import type { Dialect, DialectName, DialectRegistry } from './dialect.ts'
import type { PluginRegistry, ProvinoPlugin } from './extensions.ts'
import type { IsolationTier } from './isolation.ts'

/** The keys `ProjectConfig` adds to `BaseConfig`, apart from dialect and plugin options. */
interface ProjectKeys {
  readonly name?: string
  readonly root?: string
  /** The project-wide dialect. Without one: the highest `detect` score, else neutral. */
  readonly dialect?: DialectName
  /** Further dialects whose imports this project also serves. */
  readonly alsoServe?: readonly DialectName[]
}

/** The keys only the top-level config has. */
interface TopLevelKeys {
  readonly projects?: readonly (ProjectConfig | string)[]
}

/**
 * Config keys a dialect or plugin can't use as its name. Such a dialect or plugin gets no
 * options key in config, so pick another name. Derived from the config interfaces, so a new
 * config key is reserved automatically.
 * @public
 */
export type ReservedConfigKey = keyof BaseConfig | keyof ProjectKeys | keyof TopLevelKeys

/**
 * Each registered dialect's options, under its name (`jest: { … }`).
 * @public
 */
export type DialectKeys = {
  readonly [N in DialectName as N extends ReservedConfigKey ? never : N]?: DialectRegistry[N]
}

/**
 * Each registered plugin's options, under its name. A plugin named like a dialect yields to the
 * dialect.
 * @public
 */
export type PluginKeys = {
  readonly [N in keyof PluginRegistry & string as N extends ReservedConfigKey | DialectName
    ? never
    : N]?: PluginRegistry[N]
}

/**
 * Config keys every project accepts.
 * @public
 */
export interface BaseConfig {
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly environment?: string
  readonly isolation?: IsolationTier
  /** Inject the API as globals. */
  readonly globals?: boolean
  readonly setupFiles?: readonly string[]
  /** Dialects to load. Default: the two built-ins. */
  readonly dialects?: readonly Dialect[]
  readonly plugins?: readonly ProvinoPlugin[]
}

/**
 * One project's config.
 * @public
 */
export interface ProjectConfig extends BaseConfig, ProjectKeys, DialectKeys, PluginKeys {}

/**
 * The top-level config in `provino.config.ts`.
 * @public
 */
export interface ProvinoConfigInput extends ProjectConfig, TopLevelKeys {}

/**
 * What a config function receives.
 * @public
 */
export interface ConfigEnv {
  readonly command: 'run' | 'watch'
  readonly mode: string
}
