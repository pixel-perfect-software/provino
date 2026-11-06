import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { BaseConfig } from './config.ts'
import type { HoistPolicy } from './hoist.ts'
import type { FileRegistry } from './loader.ts'
import type { MockPolicy, ModuleRef, PolicyOverrides } from './policy/index.ts'

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
 * What a dialect's config reader produces from a `jest.config.*` or `vitest.config.*`.
 * @public
 */
export interface ConfigReadResult<Options> {
  readonly config: BaseConfig
  readonly options: Options
  readonly policy: PolicyOverrides
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Reads a runner's own config file (Track 11 owns the full contract).
 * @public
 */
export interface ConfigReader<Options> {
  /** File names to look for, in order. */
  readonly candidates: readonly string[]
  read(path: string): Promise<ConfigReadResult<Options>>
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
  /** The mock slice of the resolved policy: what a mock function built here follows. */
  readonly mockPolicy: MockPolicy
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
  readonly configReader?: ConfigReader<Options>
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
  readonly reporterAdapters?: readonly ReporterAdapter[]
  /** Type entry points, e.g. `'@provino/dialect-jest/globals'`. */
  readonly typeEntries?: readonly string[]
}
