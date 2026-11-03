// Track 2 §Types and public API: the loader contract. `@provino/loader` (B06) implements it; the
// worker, the runtime and coverage consume it. Track 2's own `Resolver`, `ResolveContext`,
// `ResolvedModule` and `TransformedModule` are not here: the loader takes Track 3's resolver and
// a `ModuleTransformer` that returns Track 3's transform record (see the package README).
import type { IsolationTier } from './isolation.ts'
import type { ModulePolicy } from './policy/module.ts'
import type { Resolver } from './resolve.ts'
import type { ModuleTransformer, SourceMapV3 } from './transform.ts'

/**
 * How modules are evaluated: Provino's module runner (vm) or Node's own loader hooks.
 * @public
 */
export type EngineKind = 'runner' | 'native'

/**
 * A module's format once loaded.
 * @public
 */
export type ModuleFormat = 'esm' | 'cjs' | 'json' | 'builtin' | 'addon' | 'wasm'

/**
 * A loaded module's id: an absolute path, `node:<name>`, or `provino-virtual:<id>`.
 * @public
 */
export type ModuleId = string & { readonly __brand: 'ModuleId' }

/**
 * Builds a mocked module's value (Track 4).
 * @public
 */
export type MockFactory<T = unknown> = () => T | Promise<T>

/**
 * How a module is mocked: by a factory, by redirecting to another module, or by automocking.
 * Track 4 builds these; the loader decides where they apply.
 * @public
 */
export type MockSpec<T = unknown> =
  | {
      readonly kind: 'factory'
      readonly factory: MockFactory<T>
      readonly shape: 'module-value' | 'namespace'
    }
  | { readonly kind: 'redirect'; readonly to: ModuleId }
  | { readonly kind: 'automock'; readonly spy: boolean }

/**
 * The global realm a `realm`-tier file runs in (Track 8 supplies it).
 * @public
 */
export interface Realm {
  readonly global: typeof globalThis
  /** The vm context, or `null` for the main realm. */
  readonly context: object | null
  dispose(): void
}

/**
 * What the loader restores and reports after each file.
 * @public
 */
export interface LeakOptions {
  /** Default `true`. */
  readonly restoreGlobals?: boolean
  /** Default `true`. */
  readonly reportPrototypePatches?: boolean
  /** Default `false` (uses `async_hooks`). */
  readonly detectOpenHandles?: boolean
  readonly allowGlobals?: readonly (string | symbol)[]
}

/**
 * Options for one worker's loader.
 * @public
 */
export interface LoaderOptions {
  readonly root: string
  readonly engine: EngineKind
  readonly resolver: Resolver
  readonly transformer: ModuleTransformer
  readonly policy: ModulePolicy
  /** Modules always loaded per file (Vitest `server.deps.inline`). */
  readonly inline?: readonly (string | RegExp)[]
  /** Default 400. */
  readonly inlineBudget?: number
  readonly leaks?: LeakOptions
}

/**
 * Options for one test file's registry. The `process` tier is a pool decision (Track 9), so it
 * never reaches the loader.
 * @public
 */
export interface FileRegistryOptions {
  readonly tier: Exclude<IsolationTier, 'process'>
  readonly realm?: Realm
}

/**
 * A compiled script, reported so coverage can map V8's URLs back to sources (Track 8).
 * @public
 */
export interface CompiledModuleEvent {
  readonly id: ModuleId
  /** The vm `filename`: what V8 coverage reports. */
  readonly scriptUrl: string
  /** Wrapper characters before user code on line 1. */
  readonly wrapperColumnOffset: number
  readonly map: SourceMapV3 | null
  readonly thirdParty: boolean
}

/**
 * What a file's teardown found and undid.
 * @public
 */
export interface LeakReport {
  readonly restored: readonly string[]
  readonly prototypePatches: readonly string[]
  readonly listenersAdded: readonly string[]
  readonly activeResources: readonly string[]
  readonly inlinedForMocks: readonly ModuleId[]
}

/**
 * One test file's module registry.
 * @public
 */
export interface FileRegistry extends Disposable {
  readonly file: string
  readonly tier: Exclude<IsolationTier, 'process'>
  import<T = unknown>(specifier: string, parent?: ModuleId | null): Promise<T>
  /** Sync; throws `ERR_REQUIRE_ASYNC_MODULE` for a graph with top-level await. */
  require<T = unknown>(specifier: string, parent?: ModuleId | null): T
  requireActual<T = unknown>(specifier: string, parent?: ModuleId | null): T
  importActual<T = unknown>(specifier: string, parent?: ModuleId | null): Promise<T>
  /** Track 4 calls these; the loader works out mock-aware inlining. */
  registerMock<T>(specifier: string, parent: ModuleId | null, spec: MockSpec<T>): void
  unregisterMock(specifier: string, parent: ModuleId | null): void
  resetModules(): void
  isolateModules<R>(fn: () => R): R
  isolateModulesAsync<R>(fn: () => Promise<R>): Promise<R>
  /** For affected-test selection (Track 9). */
  loadedModules(): readonly ModuleId[]
  [Symbol.dispose](): void
  dispose(): LeakReport
}

/**
 * One worker's loader: it creates a registry per test file.
 * @public
 */
export interface Loader extends Disposable {
  readonly engine: EngineKind
  createFileRegistry(testFile: string, options: FileRegistryOptions): FileRegistry
  /** Reads `@provino-isolate` / `@jest-environment`; never lowers the configured tier. */
  tierFor(
    testFile: string,
    configured: IsolationTier,
    docblock: Readonly<Record<string, string>>,
  ): IsolationTier
  /** Every compiled script, for V8 coverage. Returns an unsubscribe function. */
  onModuleCompiled(listener: (event: CompiledModuleEvent) => void): () => void
  getSourceMap(id: ModuleId): SourceMapV3 | null
}

/**
 * The signature of `createLoader` in `@provino/loader`.
 * @public
 */
export type CreateLoader = (options: LoaderOptions) => Loader
