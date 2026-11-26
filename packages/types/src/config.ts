// Track 1 §Config at v0. T1.4 (@provino/config) adds defineConfig, loading and validation, and
// the keys each feature needs.

import type { JsonValue } from './clone-safe.ts'
import type { SerializedCoverageConfig } from './coverage.ts'
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
import type { TransformClaims } from './loader.ts'
import type { MatcherTableFactory, ModuleRef, PoolKind, SerializedPolicy } from './policy/index.ts'
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
  /**
   * The run's projects, in one invocation: a glob or a directory (each with an optional
   * `provino.config.*` of its own), or an inline project. An inline project has no `projects`.
   */
  readonly projects?: readonly (ProjectConfig | string)[]
  /** The pool `provino run` uses when the command line names none. */
  readonly pool?: PoolKind
  /** The most workers `provino run` starts when the command line names no number. */
  readonly maxWorkers?: number
  /**
   * Node flags each forked or threaded worker starts with, after the coordinator's own
   * `process.execArgv`: one argument per entry, the first a flag (`['--conditions=development']`).
   * Node reads a relative path in a flag from the working directory. A thread refuses V8 flags such
   * as `--max-old-space-size`, the coordinator's own included (pass them in `NODE_OPTIONS`). An
   * `inline` pool or an in-band run shares the coordinator's process and ignores the key.
   */
  readonly execArgv?: readonly string[]
}

/**
 * A project's default timeouts in ms, layered over the policy's `core.timeouts`. A test or hook
 * that gives its own keeps it.
 * @public
 */
export interface ConfigTimeouts {
  readonly test?: number
  readonly hook?: number
  readonly teardown?: number
}

/**
 * How a project's imports resolve.
 * @public
 */
export interface ConfigResolve {
  /** Export conditions added after the environment's own (`['provino-source']`). */
  readonly conditions?: readonly string[]
  /**
   * Specifier aliases, as tsconfig `paths` writes them: a specifier, or a prefix ending in `/*`, to
   * a path relative to the project root (`{ '@/*': './src/*' }`).
   */
  readonly aliases?: Readonly<Record<string, string>>
  /**
   * The tsconfig whose `paths` become aliases: `auto` (the default) is the nearest
   * `tsconfig.json`, a path is that file (relative to the project root), `false` is none.
   */
  // `string & {}` keeps `'auto'` in the type (and editors' completions): a bare `string` absorbs it.
  readonly tsconfig?: 'auto' | false | (string & {})
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
  /**
   * Modules imported before each test file: a path relative to the project root, or a package
   * specifier, resolved from the root.
   */
  readonly setupFiles?: readonly string[]
  /** The environment's options (`EnvironmentRef.options`). */
  readonly environmentOptions?: Readonly<Record<string, JsonValue>>
  readonly timeouts?: ConfigTimeouts
  readonly resolve?: ConfigResolve
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
 * What `defineConfig` takes and a `provino.config.*` exports by default: the config, or a (maybe
 * async) function of the `ConfigEnv` that returns it.
 * @public
 */
export type ProvinoConfig =
  | ProvinoConfigInput
  | ((env: ConfigEnv) => ProvinoConfigInput | Promise<ProvinoConfigInput>)

/**
 * The native runtime (D185, D186): what a project with no dialect gets in place of a dialect's
 * table, scope and globals. `provino` supplies the refs, so `@provino/config` names no package
 * for them. Each `module` is an absolute path or URL (D21).
 * @public
 */
export interface NativeRuntimeRefs {
  /** Layered over the neutral policy's `expect.matcherTable: null`. */
  readonly matcherTable: ModuleRef<MatcherTableFactory>
  /** Builds the served modules' namespace (`SerializedProjectConfig.moduleScope`). */
  readonly moduleScope: ModuleRef<ModuleScopeFactory>
  /** The specifiers `moduleScope` serves before resolution (`['provino']`): `loader.scopeModules`. */
  readonly modules: readonly string[]
  /** The same values as globals, used only under `globals: true`. */
  readonly globals: ModuleRef<GlobalsFactory>
  /**
   * The served module's mock hoisting (B27j: `mock` imported from it), by value as
   * `SerializedLoaderConfig.hoist`. None: nothing hoists.
   */
  readonly hoist?: HoistPolicy
}

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
  /**
   * The hoister checks the mock factories of this rule's output against the hoist policy's
   * `factoryReferences` (`NeutralTransform.checksMockFactories`). Absent or `false`: it allows
   * every reference in them.
   */
  readonly checksMockFactories?: boolean
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
  /** The dialect's served module specifiers (`Dialect.moduleScope.modules`); absent means none. */
  readonly scopeModules?: readonly string[]
  /** The part of `scopeModules` a matching name-mapper rule takes over (`Dialect.moduleScope.mappable`). */
  readonly scopeMappable?: readonly string[]
  /** Extensions tried for a specifier without one, in order (`.ts`, `.js`, …). */
  readonly extensions: readonly string[]
  /** Environment export conditions for resolution; the call kind adds its own. */
  readonly conditions: readonly string[]
  /** `auto`: the nearest `tsconfig.json`; a path: that file (absolute); `false`: none. */
  readonly tsconfig: 'auto' | false | string
  /** Mappers in the order they run; the first hit wins. Loaded by `ModuleRef` in the worker (each factory's `module` is absolute). */
  readonly mappers: readonly SerializedModuleMapper[]
  /**
   * How TypeScript is stripped: `oxc` (Oxc's transform; a file instrumented for coverage is
   * stripped in place, D116), `blank` (every erasable `.ts`, `.mts` and `.cts` file in place).
   */
  readonly typescript: 'oxc' | 'blank' | 'node-strip' | 'off'
  /** User transformers (T3.8); absent for none, where every file takes the Oxc pipeline. */
  readonly transform?: SerializedTransformConfig
  /**
   * The files the project's transforms take, the ones Provino's pipeline stands in for included
   * (`LoaderOptions.transformClaims`), so a `node_modules` file a transform takes is known even when
   * `transform` is absent. Absent: no transform, so no `node_modules` file is taken.
   */
  readonly transformClaims?: TransformClaims
  /**
   * The transform cache's directory (T3.6), an absolute path; absent for no cache (`--no-cache`).
   * The coordinator makes it ready before any worker starts, so a worker only reads and writes
   * entries.
   */
  readonly cacheDir?: string
  /**
   * The hash of the transform package's own code (`transformCodeIdentity`), which the coordinator
   * computes once so that no worker reads and hashes that package again. Part of every cache
   * entry's key. Absent: the worker computes it.
   */
  readonly codeIdentity?: string
  /**
   * The dialect's name-mapping rules (Jest's `moduleNameMapper`; T3.3), regex sources in order. They
   * run before `mappers`. Absent means none.
   */
  readonly aliases?: readonly NeutralAlias[]
  /** Replaces `node_modules` as the directories searched up the tree (Jest `moduleDirectories`). */
  readonly moduleDirectories?: readonly string[]
  /** Absolute directories searched after a miss (Jest `modulePaths`). */
  readonly modulePaths?: readonly string[]
  /**
   * Extensions whose files run as ES modules beyond `.mjs` and a `"type": "module"` package's `.js`
   * (Jest `extensionsToTreatAsEsm`); read under `module.edgeResolveKind: 'importer-format'`. Absent
   * means none.
   */
  readonly esmExtensions?: readonly string[]
  /** A custom resolver module (Jest `resolver`), its `module` absolute; the export is `default`. */
  readonly resolver?: ModuleRef
  /**
   * The affected-test graph resolves a specifier with no path separator only through a mapper
   * (Jest `skipNodeResolution`). Only the coordinator's dependency resolution reads it. Absent
   * means `false`.
   */
  readonly skipNodeResolution?: boolean
  /**
   * The node_modules files an earlier run's workers learned to evaluate per file
   * (`ModulePolicy.reevaluateHookingExternals`, D127), as absolute paths, from the results cache:
   * the worker inlines them from its first file. Absent means none.
   */
  readonly reevaluate?: readonly string[]
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
  /** The dialect's resolver for a docblock's environment (`Dialect.environmentResolver`); absent for none. */
  readonly environmentResolver?: ModuleRef<EnvironmentResolver>
  /**
   * Values defined on the environment's global for each file, before anything else runs (Jest's
   * `globals`: jest-environment-node's `installCommonGlobals`). Absent means none.
   */
  readonly globalValues?: Readonly<Record<string, JsonValue>>
  /** The project's fake-timer defaults (`NeutralProject.fakeTimers`). Absent means none. */
  readonly fakeTimers?: Readonly<Record<string, JsonValue>>
  /** The run's random seed (`jest.getSeed()`): the coordinator draws one per run, or takes the project's own (`NeutralProject.seed`). */
  readonly seed: number
  /**
   * Shuffle each file's suites with `seed` (`CorePolicy.shuffle`; Jest's `--randomize`). Absent
   * means the declared order.
   */
  readonly randomize?: true
  /** Absolute paths, imported before each test file, first (Jest `setupFiles`). */
  readonly setupFiles: readonly string[]
  /** Absolute paths, imported after `setupFiles` and before each test file (Jest `setupFilesAfterEnv`, Vitest `setupFiles`). */
  readonly setupFilesAfterEnv: readonly string[]
  readonly loader: SerializedLoaderConfig
  /** Present when the run collects coverage; absent means off. */
  readonly coverage?: SerializedCoverageConfig
  /**
   * The project's own snapshot resolver module, an absolute path (Jest's `snapshotResolver`),
   * loaded through each file's registry and handed to `SnapshotPolicy.resolverFactory`. Absent
   * means the policy's own layout.
   */
  readonly snapshotResolver?: string
}
