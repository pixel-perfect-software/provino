// Track 1 §Config at v0. T1.4 (@provino/config) adds defineConfig, loading and validation, and
// the keys each feature needs.

import type { JsonValue } from './clone-safe.ts'
import type {
  Dialect,
  DialectName,
  DialectRegistry,
  GlobalsFactory,
  ModuleScopeFactory,
} from './dialect.ts'
import type { EnvironmentRef } from './environment.ts'
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
 * One transform rule as it crosses coordinator → worker: a file whose absolute path matches
 * `pattern` (a regular expression's source) goes through the transformer `transformer` names,
 * created with `options`. `transformer.module` is an absolute path or URL (D21) and its `export`
 * is always `'default'`: the worker loads the module the way Jest's `requireOrImportModule` does
 * (its `default` when it is an ES module, else `module.exports`) and calls its `createTransformer`
 * when it has one, so the ref names a module, not a function.
 * @public
 */
export interface SerializedTransform {
  readonly pattern: string
  readonly transformer: ModuleRef
  readonly options: JsonValue
}

/**
 * The user transformers of a project (Track 3, T3.8), in config order: the first rule whose
 * `pattern` matches a file wins, as Jest's `transform` does.
 * @public
 */
export interface SerializedTransformConfig {
  readonly rules: readonly SerializedTransform[]
  /** Regular expressions' sources, joined with `|`: a file one matches isn't transformed. */
  readonly ignorePatterns: readonly string[]
  /**
   * What a transformer reads as `options.config`: the project's own config, as JSON (Jest's
   * `ProjectConfig`), with its stable JSON text as `configString`. It holds data only, so it
   * crosses; what a transformer needs from it (`rootDir`, `cwd`, `globals`, `testMatch`, …) is
   * the dialect's to supply.
   */
  readonly config: Readonly<Record<string, JsonValue>>
  /**
   * Identifiers whose presence in a transformer's output means the transformer already hoisted the
   * file's mock calls (Babel's Jest plugin writes `_getJestObj`); the host's own hoister then
   * leaves the file alone. A transformer that hoists without one of these (ts-jest, `@swc/jest`)
   * meets the hoister, which finds every call already at the top of its block and moves nothing.
   */
  readonly hoistedMarkers: readonly string[]
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
  /** User transformers (T3.8); absent for none, where every file takes the Oxc pipeline. */
  readonly transform?: SerializedTransformConfig
  /**
   * The transform cache's directory (T3.6), an absolute path; absent for no cache (`--no-cache`).
   * The coordinator makes it ready before any worker starts, so a worker only reads and writes
   * entries.
   */
  readonly cacheDir?: string
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
  /** Absolute paths, imported before each test file, first (Jest `setupFiles`). */
  readonly setupFiles: readonly string[]
  /** Absolute paths, imported after `setupFiles` and before each test file (Jest `setupFilesAfterEnv`, Vitest `setupFiles`). */
  readonly setupFilesAfterEnv: readonly string[]
  readonly loader: SerializedLoaderConfig
}
