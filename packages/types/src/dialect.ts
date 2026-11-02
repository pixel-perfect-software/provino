import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { BaseConfig } from './config.ts'
import type { HoistPolicy } from './hoist.ts'
import type { PolicyOverrides } from './policy/index.ts'

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
  readonly globals?: { readonly module: string; readonly names: readonly string[] }
  readonly loader?: LoaderPolicies
  readonly reporterAdapters?: readonly ReporterAdapter[]
  /** Type entry points, e.g. `'@provino/dialect-jest/globals'`. */
  readonly typeEntries?: readonly string[]
}
