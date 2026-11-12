// Track 1 §Config at v0. T1.4 (@provino/config) adds defineConfig, loading and validation, and
// the keys each feature needs.

import type { JsonValue } from './clone-safe.ts'
import type {
  Dialect,
  DialectName,
  DialectRegistry,
  GlobalsFactory,
  ModuleScopeFactory,
  NeutralAlias,
} from './dialect.ts'
import type { EnvironmentRef, EnvironmentResolver } from './environment.ts'
import type { PluginRegistry, ProvinoPlugin } from './extensions.ts'
import type { HoistPolicy } from './hoist.ts'
import type { IsolationTier } from './isolation.ts'
import type { ModuleRef, SerializedPolicy } from './policy/index.ts'
import type { SerializedModuleMapper } from './resolve.ts'

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

/**
 * The clone-safe resolver and transform settings a worker builds its loader from
 * (`createProjectLoader` in `@provino/loader`). Everything else a resolver or pipeline can take
 * (a Jest `custom` resolver, the transform cache) either has a closure in it or is not wired yet.
 * The hoist policy crosses by value: it is data, with `RegExp` and `Set` leaves, which clone.
 * @public
 */
export interface SerializedLoaderConfig {
  /** The dialect's mock-hoisting rules (`Dialect.loader.hoist`), or `null` for none. */
  readonly hoist: HoistPolicy | null
  /** The dialect's per-module binding names (`Dialect.moduleScope.names`); `[]` for none. */
  readonly moduleScope: readonly string[]
  /** The dialect's served module specifiers (`Dialect.moduleScope.modules`); absent means none. */
  readonly scopeModules?: readonly string[]
  /** Extensions tried for a specifier without one, in order (`.ts`, `.js`, …). */
  readonly extensions: readonly string[]
  /** Environment export conditions for resolution; the call kind adds its own. */
  readonly conditions: readonly string[]
  /** `auto`: the nearest `tsconfig.json`; a path: that file (absolute); `false`: none. */
  readonly tsconfig: 'auto' | false | string
  /** Mappers in the order they run; the first hit wins. Loaded by `ModuleRef` in the worker (each factory's `module` is absolute). */
  readonly mappers: readonly SerializedModuleMapper[]
  /** How TypeScript is stripped. */
  readonly typescript: 'oxc' | 'node-strip' | 'off'
  /**
   * The dialect's name-mapping rules (Jest's `moduleNameMapper`; T3.3), regex sources in order. They
   * run before `mappers`. Absent means none.
   */
  readonly aliases?: readonly NeutralAlias[]
  /** Replaces `node_modules` as the directories searched up the tree (Jest `moduleDirectories`). */
  readonly moduleDirectories?: readonly string[]
  /** Absolute directories searched after a miss (Jest `modulePaths`). */
  readonly modulePaths?: readonly string[]
  /** A custom resolver module (Jest `resolver`), its `module` absolute; the export is `default`. */
  readonly resolver?: ModuleRef | null
}

/**
 * One project's resolved config as it crosses coordinator → worker, once per worker
 * (`WorkerInit.config`). One project per worker. Functions, plugins and the dialect objects are
 * gone: behaviour is a `ModuleRef`, the environment an `EnvironmentRef`.
 *
 * Everything that names a place crosses already resolved (the coordinator resolves it; the worker
 * rejects anything else with `ORCH_BAD_CONFIG` naming the key). `rootDir`, each of `setupFiles`
 * and `setupFilesAfterEnv`, a path `loader.tsconfig` and each mapper factory's `module` are
 * absolute paths (or, for a `module`, an absolute URL). `environment.module` and `globals.module`
 * are each an absolute path or an absolute URL (a `file:` URL). None is a bare package specifier
 * or a path relative to the worker's own working directory.
 * @public
 */
export interface SerializedProjectConfig {
  /** The project's name: part of every task id. */
  readonly name: string
  /** The project root, an absolute path. */
  readonly rootDir: string
  /** Whether this is a CI run (`allowOnly: 'not-in-ci'`). */
  readonly ci: boolean
  readonly policy: SerializedPolicy
  readonly environment: EnvironmentRef
  /** The dialect's globals factory (its `module` absolute, as above), or `null` for a dialect that injects none. */
  readonly globals: ModuleRef<GlobalsFactory> | null
  /**
   * The factory of the dialect's per-module bindings (its `module` absolute, as above), or `null`
   * for a dialect with none. Its names are `loader.moduleScope`.
   */
  readonly moduleScope: ModuleRef<ModuleScopeFactory> | null
  /** The dialect's resolver for a docblock's environment (`Dialect.environmentResolver`); absent or `null` for none. */
  readonly environmentResolver?: ModuleRef<EnvironmentResolver> | null
  /**
   * Values defined on the environment's global for each file, before anything else runs (Jest's
   * `globals`: jest-environment-node's `installCommonGlobals`). Absent means none.
   */
  readonly globalValues?: Readonly<Record<string, JsonValue>>
  /** The project's fake-timer defaults (`NeutralProject.fakeTimers`). Absent means none. */
  readonly fakeTimers?: Readonly<Record<string, JsonValue>>
  /** The run's random seed (`NeutralProject.seed`). Absent: the worker draws its own. */
  readonly seed?: number
  /** Absolute paths, imported before each test file, first (Jest `setupFiles`). */
  readonly setupFiles: readonly string[]
  /** Absolute paths, imported after `setupFiles` and before each test file (Jest `setupFilesAfterEnv`, Vitest `setupFiles`). */
  readonly setupFilesAfterEnv: readonly string[]
  readonly loader: SerializedLoaderConfig
}
