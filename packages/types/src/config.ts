// Track 1 §Config at v0. T1.4 (@provino/config) adds defineConfig, loading and validation, and
// the keys each feature needs.
import type { Dialect, DialectName, DialectRegistry } from './dialect.ts'
import type { PluginRegistry, ProvinoPlugin } from './extensions.ts'
import type { IsolationTier } from './isolation.ts'

/**
 * Each registered dialect's options, under its name (`jest: { … }`).
 * @public
 */
export type DialectKeys = { readonly [N in DialectName]?: DialectRegistry[N] }

/**
 * Each registered plugin's options, under its name.
 * @public
 */
export type PluginKeys = { readonly [N in keyof PluginRegistry & string]?: PluginRegistry[N] }

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
export interface ProjectConfig extends BaseConfig, DialectKeys, PluginKeys {
  readonly name?: string
  readonly root?: string
  /** The project-wide dialect. Without one: the highest `detect` score, else neutral. */
  readonly dialect?: DialectName
  /** Further dialects whose imports this project also serves. */
  readonly alsoServe?: readonly DialectName[]
}

/**
 * The top-level config in `provino.config.ts`.
 * @public
 */
export interface ProvinoConfigInput extends ProjectConfig {
  readonly projects?: readonly (ProjectConfig | string)[]
}

/**
 * What a config function receives.
 * @public
 */
export interface ConfigEnv {
  readonly command: 'run' | 'watch'
  readonly mode: string
}
