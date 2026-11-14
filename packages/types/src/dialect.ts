import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { JsonValue } from './clone-safe.ts'
import type { SerializedCoverageConfig } from './coverage.ts'
import type { EnvironmentResolver } from './environment.ts'
import type { HoistPolicy } from './hoist.ts'
import type { FileRegistry, ModuleMockRegistry } from './loader.ts'
import type {
  GlobalSetupArgs,
  MockPolicy,
  ModuleRef,
  PolicyOverrides,
  TimersPolicy,
} from './policy/index.ts'
import type { CliDialect } from './run-request.ts'
import type { DefaultRetry, DescribeRetry, DescribeRetryResult } from './runtime/context.ts'

/**
 * Dialect option types by dialect name. Each dialect package augments it:
 * `declare module '@provino/types' { interface DialectRegistry { jest: JestDialectOptions } }`.
 * Augmentation is program-wide, so a program sees every dialect any of its files references.
 * @public
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by dialect packages (declaration merging).
export interface DialectRegistry {}

/**
 * The name of a registered dialect.
 * @public
 */
export type DialectName = keyof DialectRegistry & string

/**
 * What `detect` sees when scoring how well a dialect fits a project (Track 11 adds signals).
 * @public
 */
export interface DetectContext {
  readonly root: string
  readonly packageJson: Readonly<Record<string, unknown>> | undefined
  readonly configFiles: readonly string[]
}

/**
 * A problem found while reading a config.
 * @public
 */
export interface Diagnostic {
  readonly level: 'error' | 'warning'
  readonly code: string
  readonly message: string
  readonly key?: string
}

/**
 * Where a runner's config was found: a config file, a `package.json` (its runner key), or config
 * given as text (Jest's `--config '{…}'`). `path` is absolute: the file, or for `inline` the
 * directory the config's relative paths start from.
 * @public
 */
export type ConfigSource =
  | { readonly kind: 'file' | 'package-json'; readonly path: string }
  | { readonly kind: 'inline'; readonly path: string; readonly text: string }

/**
 * What a reader step returns: its value and the problems it found along the way (warnings, such as
 * Jest's "did you mean"; an error is thrown, not returned).
 * @public
 */
export interface ConfigReadOutcome<Value> {
  readonly value: Value
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * One module-mapping rule (Jest's `moduleNameMapper` entry): a specifier matching `pattern` (a
 * regular expression's source) is replaced by the first of `targets` that resolves, with `$1`…
 * from the match. Rules run in order and the first match wins.
 * @public
 */
export interface NeutralAlias {
  readonly pattern: string
  readonly targets: readonly string[]
}

/**
 * The resolver keys of a project (T3.3). Absent keys keep the resolver's defaults.
 * @public
 */
export interface NeutralResolution {
  readonly moduleDirectories?: readonly string[]
  /** Absolute directories. */
  readonly modulePaths?: readonly string[]
  /** An absolute path to a custom resolver module (Jest's `resolver`). */
  readonly resolver?: string
}

/**
 * One transform rule (Jest's `transform` entry): a file whose path matches `pattern` (a regular
 * expression's source) goes through `module` (an absolute path, or the bare name of a package the
 * runner itself ships) with `options`.
 * @public
 */
export interface NeutralTransform {
  readonly pattern: string
  readonly module: string
  readonly options: JsonValue
}

/**
 * How a project finds its test files. Patterns match absolute paths. `includePatterns` is globs
 * (Jest's `testMatch`) or regular expressions' sources (`testRegex`), never both;
 * `excludePatterns` (`testPathIgnorePatterns`) and `crawlIgnorePatterns`
 * (`modulePathIgnorePatterns`) are regular expressions' sources. `extensions` have no dot.
 * @public
 */
export interface NeutralDiscovery {
  /** Absolute directories to look in. */
  readonly roots: readonly string[]
  readonly extensions: readonly string[]
  readonly includePatterns: {
    readonly kind: 'glob' | 'regex'
    readonly patterns: readonly string[]
  }
  readonly excludePatterns: readonly string[]
  readonly crawlIgnorePatterns: readonly string[]
}

/**
 * One project as a dialect's config reader hands it to the neutral config (`resolveNeutralProject`
 * in `@provino/config`). It stays in the coordinator, but holds no `RegExp` and no function, and
 * every path in it is absolute (D21), so what is built from it can cross to a worker.
 * @public
 */
export interface NeutralProject {
  /** `''` when the config gives none. */
  readonly name: string
  readonly rootDir: string
  readonly discovery: NeutralDiscovery
  /** Absolute paths, run before the test framework is installed (Jest's `setupFiles`). */
  readonly setupFiles: readonly string[]
  /** Absolute paths, run after it (Jest's `setupFilesAfterEnv`, Vitest's `setupFiles`). */
  readonly setupFilesAfterEnv: readonly string[]
  /** Absolute paths, or `[]`. Run in the coordinator, once per distinct path (T9.15). */
  readonly globalSetup: readonly string[]
  readonly globalTeardown: readonly string[]
  /**
   * What a global setup or teardown function receives under the policy's
   * `global-and-project-config` signature (Jest's `GlobalConfig` and `ProjectConfig`, as the
   * reader holds them). It stays in the coordinator, where the hook runs, so it need not be JSON.
   * Absent when neither the project nor the run has a global setup or teardown, or for a
   * signature that takes the project. A project with no hook of its own still has it when the run
   * has one (Jest's root `globalSetup` with `projects`): that hook is called with the config of the
   * first project.
   */
  readonly globalSetupArgs?: GlobalSetupArgs
  /** The environment's neutral name (`node`, `jsdom`), or an absolute path to a custom one. */
  readonly environment: {
    readonly name: string
    readonly options: Readonly<Record<string, JsonValue>>
  }
  readonly aliases: readonly NeutralAlias[]
  /** How specifiers resolve beyond `aliases` (Jest's `moduleDirectories`, `modulePaths`, `resolver`). */
  readonly resolution?: NeutralResolution
  /** Which files count toward coverage, when the project or the run turns it on. Absent means off. */
  readonly coverage?: SerializedCoverageConfig
  /** Values put on the environment's global before `setupFiles` (Jest's `globals`), as data. */
  readonly globalValues?: Readonly<Record<string, JsonValue>>
  /**
   * The project's fake-timer defaults (Jest's `fakeTimers`: `now`, `doNotFake`, `timerLimit`,
   * `advanceTimers`, `legacyFakeTimers`): what every `useFakeTimers` call, and the global install
   * `policy.timers.enableGlobally` asks for, is layered over.
   */
  readonly fakeTimers?: Readonly<Record<string, JsonValue>>
  /** The run's random seed (Jest's `seed`, `jest.getSeed()`); one for every worker of a run. */
  readonly seed?: number
  /** Shuffle each file's suites with the seed (Jest's `randomize`). Absent means the declared order. */
  readonly randomize?: true
  readonly transforms: readonly NeutralTransform[]
  /** Regular expressions' sources: files they match are not transformed. */
  readonly transformIgnorePatterns: readonly string[]
  /**
   * What a transformer reads as its `config` option (Jest's `ProjectConfig`), as JSON. Absent
   * when no transform is configured.
   */
  readonly transformConfig?: Readonly<Record<string, JsonValue>>
  /** Identifiers in a transformer's output that show it hoisted mocks itself; `[]` or absent for none. */
  readonly transformHoistedMarkers?: readonly string[]
  /** Absolute paths. */
  readonly snapshotSerializers: readonly string[]
  /** Watch mode's own settings (Jest's `watchPathIgnorePatterns`: regular expressions' sources). */
  readonly watch?: { readonly ignorePatterns: readonly string[] }
  /** Affected-test selection's own settings. */
  readonly affected?: {
    /**
     * The project's own dependency extractor (Jest's `dependencyExtractor`), read before the
     * policy's. The module exports an object (with an `extract` method), not a function, so the
     * behaviour loader's `loadRef` (which requires a function export) cannot load it: B23c Phase 4
     * loads it with a plain `import()`.
     */
    readonly extractor?: ModuleRef
  }
  /**
   * A cache directory the config sets itself (an absolute path), as opposed to a runner's own
   * default. Provino keeps its caches under `<cacheDirectory>/provino` when it is set (D70), and
   * under `<rootDir>/node_modules/.cache/provino` when it isn't.
   */
  readonly cacheDirectory?: string
  /** The config's keys that map onto the policy, as overrides over the dialect's own. */
  readonly policy: PolicyOverrides
}

/**
 * Reads a runner's own config (Track 11's contract): `find` it, `load` what the file gives,
 * `resolve` that the way the runner does (presets, defaults, `<rootDir>`, paths), and turn the
 * result into neutral projects. `Raw` and `Resolved` are the dialect's own shapes; the methods are
 * declared as methods, so a reader of any `Raw` and `Resolved` is a `ConfigReader`.
 * @public
 */
export interface ConfigReader<Raw = unknown, Resolved = unknown> {
  /** File names looked for in each directory, in order. */
  readonly candidates: readonly string[]
  /**
   * Finds the config for `cwd`, or the one `explicit` names (a path, or inline text where the
   * runner accepts it). `undefined` when an implicit search finds nothing; an explicit one that
   * finds nothing throws.
   */
  find(cwd: string, explicit?: string): Promise<ConfigSource | undefined>
  load(source: ConfigSource): Promise<Raw>
  resolve(raw: Raw, source: ConfigSource): Promise<ConfigReadOutcome<Resolved>>
  toNeutral(resolved: Resolved): ConfigReadOutcome<readonly NeutralProject[]>
}

/**
 * A CLI flag a dialect accepts (`-t`, `--runInBand`, …).
 * @public
 */
export interface FlagSpec {
  readonly name: string
  readonly short?: string
  readonly takesValue: boolean
  readonly description: string
}

/**
 * A module a dialect serves: `specifier` is what tests import (`@jest/globals`), `module` is
 * the facade that implements it.
 * @public
 */
export interface ApiModule {
  readonly specifier: string
  readonly module: string
}

/**
 * Per-dialect loader settings: mock hoisting (Track 3) and specifier aliases (U9).
 * @public
 */
export interface LoaderPolicies {
  readonly hoist?: HoistPolicy
  /** Specifier → module that serves it, applied at resolve (`@jest/globals`, `vitest/*`). */
  readonly specifierAliases?: Readonly<Record<string, string>>
}

/**
 * Maps a runner's reporter name to the module that implements it.
 * @public
 */
export interface ReporterAdapter {
  readonly name: string
  readonly module: string
}

/**
 * Builds a dialect's policy from its options. Bivariant in `Options`, so every dialect is
 * assignable to `Dialect` (a dialect list holds dialects with different option types). The cost:
 * through a plain `Dialect`, the factory accepts any argument, so callers must validate
 * `config[name]` with the dialect's `options` schema before calling it.
 * @public
 */
export type DialectPolicyFactory<Options> = {
  bivarianceHack(options: Options): PolicyOverrides
}['bivarianceHack']

/**
 * What a dialect builds its injected globals from: the worker's runtime objects, which a dialect
 * module has no other way to reach (module-level state would be shared by every worker).
 *
 * `api` and `expect` are typed `object` here because their real types live in packages `types`
 * can't import: `api` is `RuntimeApi` from `@provino/core` (`runtime.api`: `describe`, `test`, the
 * hooks), and `expect` is the worker's `expect` from `@provino/expect` (`ExpectStatic`). A dialect
 * that imports those packages declares a host extending this one with the real types, and its
 * factory is still a `GlobalsFactory` (see there).
 * @public
 */
export interface GlobalsHost {
  /** Core's global API (`RuntimeApi`). */
  readonly api: object
  /** The worker's `expect`. */
  readonly expect: object
  /**
   * The registry of the file running now: a global such as `jest.resetModules` acts on it. Read it
   * when the global is called, not when the factory runs, because each file gets its own.
   */
  registry(): FileRegistry
  /**
   * The mock registry of the file running now (`MockRegistry` from `@provino/mock`; one per
   * worker under isolation `none`). Read it when the global is called, like `registry()`.
   */
  mocks(): object
  /**
   * The module-mock registry of the file running now (one per file, in every tier). Read it when
   * the global is called, like `registry()`.
   */
  moduleMocks(): ModuleMockRegistry
  /** The mock slice of the resolved policy: what a mock function built here follows. */
  readonly mockPolicy: MockPolicy
  /**
   * The fake clock of the file running now (`FakeClock` from `@provino/timers`; one per file, on
   * the environment's global, whatever the tier). Read it when the global is called, like
   * `registry()`.
   */
  timers(): object
  /** The timers slice of the resolved policy: what a timer member built here follows. */
  readonly timersPolicy: TimersPolicy
  /** The run's random seed (`SerializedProjectConfig.seed`, else one drawn when the worker booted). */
  readonly seed: number
  /**
   * Whether the file's environment is gone: true once its teardown has run, for code that outlives
   * the file (a late callback). Read it when the global is called.
   */
  environmentTornDown(): boolean
  /**
   * Sets the timeout a test or hook with none of its own gets, until the file that is running
   * ends (`Runtime.setDefaultTimeout`).
   */
  setDefaultTimeout(ms: number | undefined): void
  /**
   * Sets the retry that every test with none of its own gets, until the file that is running ends
   * (`Runtime.setDefaultRetry`). `undefined` clears it.
   */
  setDefaultRetry(retry: DefaultRetry | undefined): void
  /**
   * Sets the retry of the describe block being collected (the file's root at its top level;
   * `Runtime.setDescribeRetry`). `started` once the file's run has begun.
   */
  setDescribeRetry(retry: DescribeRetry): DescribeRetryResult
}

/**
 * Builds the values of a dialect's per-module bindings: given the worker's host once, it returns
 * the function the loader calls for each module that names a binding (`from` is that module).
 * Bivariant in the host, as `GlobalsFactory` is.
 * @public
 */
export type ModuleScopeFactory = {
  bivarianceHack(host: GlobalsHost): (from: string) => Readonly<Record<string, unknown>>
}['bivarianceHack']

/**
 * A dialect's per-module bindings (Jest gives each module its own `jest`, as jest-runtime's
 * `_createJestObjectFor(from)` does): the names every module's wrapper declares, and the factory
 * that builds their values, by `ModuleRef` so it loads in the worker.
 * @public
 */
export interface ModuleScope {
  readonly names: readonly string[]
  /**
   * Module specifiers the runner itself serves (Jest's `@jest/globals`; U9's `expect`,
   * `@jest/expect` and `jest-mock`). An import of one never reaches the resolver, the mapper
   * rules or a mock: the value is the factory's result under that key, for the importing module.
   */
  readonly modules?: readonly string[]
  /**
   * The part of `modules` that yields to the project's name mapper: a rule that matches the
   * specifier takes it over, and the scope serves it only when none does. The rest of `modules`
   * is answered before the mapper (Jest's `@jest/globals`).
   */
  readonly mappable?: readonly string[]
  readonly factory: ModuleRef<ModuleScopeFactory>
}

/**
 * Builds a dialect's globals (`describe`, `it`, `expect`, `jest`, …) from the worker's runtime.
 * Bivariant in the host (the `DialectPolicyFactory` pattern), so a factory that declares a
 * narrower host with core's and expect's real types is still a `GlobalsFactory`. The cost: through
 * a plain `GlobalsFactory` it accepts any host, so the worker must pass the host it declares.
 * @public
 */
export type GlobalsFactory = {
  bivarianceHack(host: GlobalsHost): Readonly<Record<string, unknown>>
}['bivarianceHack']

/**
 * A dialect: the policy and API facets that make Provino behave like one runner.
 * @public
 */
export interface Dialect<Name extends string = string, Options = unknown> {
  readonly name: Name
  /** The upstream version it mirrors, e.g. `'30.5'`. */
  readonly version: string
  /** Scores how well the dialect fits a project; the highest score wins. */
  readonly detect?: (context: DetectContext) => number | Promise<number>
  readonly policy: PolicyOverrides | DialectPolicyFactory<Options>
  /** Validates `config[name]`. */
  readonly options?: StandardSchemaV1<unknown, Options>
  readonly configReader?: ConfigReader
  /** Parses this runner's command line into a `RunRequest` (Track 11 T11.7). */
  readonly cli?: CliDialect
  readonly flags?: readonly FlagSpec[]
  readonly modules?: readonly ApiModule[]
  /**
   * The globals it injects: `factory` builds them in the worker (by `ModuleRef`, so a closure
   * can't be given), and `names` lists the ones it returns.
   */
  readonly globals?: {
    readonly factory: ModuleRef<GlobalsFactory>
    readonly names: readonly string[]
  }
  readonly loader?: LoaderPolicies
  /** Bindings each module gets its own value of; `names` are declared only when globals are injected. */
  readonly moduleScope?: ModuleScope
  /** Resolves the environment a test file's docblock names (Jest's `@jest-environment`), in the worker. */
  readonly environmentResolver?: ModuleRef<EnvironmentResolver>
  readonly reporterAdapters?: readonly ReporterAdapter[]
  /** Type entry points, e.g. `'@provino/dialect-jest/globals'`. */
  readonly typeEntries?: readonly string[]
}
