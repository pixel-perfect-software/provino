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
export type MockFactory<T = unknown> = (importOriginal: () => Promise<unknown>) => T | Promise<T>

/**
 * How a module is mocked: by a factory, by redirecting to another module, by automocking, or not
 * at all (`unmock`). The policy holds the factory's result shape. Track 4 builds these; the loader
 * decides where they apply.
 * @public
 */
export type MockSpec<T = unknown> =
  | { readonly kind: 'factory'; readonly factory: MockFactory<T> }
  | { readonly kind: 'redirect'; readonly to: ModuleId }
  | { readonly kind: 'automock'; readonly spy: boolean }
  | { readonly kind: 'unmock' }

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
 * The names of a dialect's per-module bindings (Jest's `jest`): every module's wrapper declares
 * them, so they are fixed for the worker. The values come per file (`FileRegistryOptions.moduleScope`).
 * @public
 */
export interface ModuleScopeNames {
  readonly names: readonly string[]
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
  /** Environment export conditions for resolution (Track 8); the call kind adds its own. Default `['node']`. */
  readonly conditions?: readonly string[]
  /** Modules always loaded per file (Vitest `server.deps.inline`). */
  readonly inline?: readonly (string | RegExp)[]
  /** Default 400. */
  readonly inlineBudget?: number
  readonly leaks?: LeakOptions
  /** The dialect's per-module bindings (B13c Gap 2). None by default. */
  readonly moduleScope?: ModuleScopeNames
}

/**
 * The answer to "is this import mocked?". `id` is what `ModuleMockRegistry.materialize` takes.
 * @public
 */
export type MockDecision =
  | { readonly mocked: false }
  | { readonly mocked: true; readonly id: string }

/**
 * Options for one `ModuleMockRegistry.register` call.
 * @public
 */
export interface ModuleMockRegisterOptions {
  /** The file that made the call (absolute): the specifier resolves from here. */
  readonly from: string
  /** The module need not exist. Under `requireVirtualFlag: false` a missing module is virtual anyway. */
  readonly virtual?: boolean
}

/**
 * Options for a `LoadActual` call.
 * @public
 */
export interface LoadActualOptions {
  /**
   * Load in a scratch layer: a fresh instance map for the module and everything it loads, dropped
   * afterwards, so the real load leaves nothing behind in the file's registry (automock's real
   * load, as Jest's `_generateMock` swaps its registries).
   */
  readonly scratch?: boolean
}

/**
 * Loads a module's real exports by its id (a manual mock's file too), bypassing the mock of that
 * module only: what it imports still goes through `decide`. Synchronous, or a Promise, as
 * `ModulePolicy.actual` says.
 * @public
 */
export type LoadActual = (id: string, importer: string, options?: LoadActualOptions) => unknown

/**
 * One test file's module-mock registry (Track 4, `@provino/mock` implements it). The loader asks
 * `decide` on every import, `require` and `import()` edge and `materialize` for a mocked id; the
 * registry owns everything between (registrations, `__mocks__`, the factory's result, automock,
 * the isolation overlay).
 * @public
 */
export interface ModuleMockRegistry {
  /**
   * `jest.mock`/`vi.mock`/`unmock` and their `do` forms. Resolves at once (kind `mock`) and
   * throws the dialect's `module-missing` text for a missing module without `virtual`, under
   * `requireVirtualFlag`.
   */
  register(specifier: string, spec: MockSpec, options: ModuleMockRegisterOptions): void
  /**
   * Whether an import edge is mocked: explicit unmock, explicit registration, automock-all, root
   * `__mocks__` (when `rootMocksAutoApply`). `specifier` is the text as written, for the root-mock
   * name. With nothing registered, automock off and no root mock, it returns before any lookup.
   */
  decide(
    resolvedId: string,
    importer: string,
    kind: 'esm' | 'cjs' | 'builtin',
    specifier?: string,
  ): MockDecision
  /** The same for a specifier that didn't resolve: a virtual module, or a root-mocked package that isn't installed. */
  decideUnresolved(specifier: string, importer: string): MockDecision
  /** The mock's value, built once and cached (per isolation overlay). A Promise under `awaitFactory`, or when `loadActual` returns one. */
  materialize(id: string): unknown
  /**
   * The mocked value of `specifier` as `from` names it, whether or not it is registered: the
   * registration's, else the manual mock, else an automock (`jest.requireMock`, `vi.importMock`).
   */
  mockFor(specifier: string, from: string): unknown
  /** An automock of the real module `specifier` names, loaded in a scratch layer and not cached (`jest.createMockFromModule`). */
  createMockFromModule(specifier: string, from: string): unknown
  /** `resetModules()`: drops cached values when the module registry owns them (`mockValueOwner`). */
  onResetModules(): void
  /** Turns automock-all on or off (`enableAutomock`/`disableAutomock`); starts at `policy.automock`. */
  setAutomock(enabled: boolean): void
  /** Opens `isolateModules`'s overlay; throws the dialect's `nested-isolation` text if one is open. */
  enterIsolation(caller?: string, other?: string): void
  exitIsolation(): void
  /** Forgets everything; further calls throw. Calling it again does nothing. */
  dispose(): void
}

/**
 * What the loader hands a file's module-mock factory: its own real-module loader and the
 * worker's resolver, so the registry resolves registrations as the loader resolves imports.
 * @public
 */
export interface ModuleMocksContext {
  readonly loadActual: LoadActual
  readonly resolver: Resolver
  /** The loader's resolution conditions. */
  readonly conditions: readonly string[]
}

/**
 * Builds a file's module-mock registry. The worker supplies it, because the registry also needs
 * the mock slice and the file's mock-function registry, which the loader never reads.
 * @public
 */
export type ModuleMocksFactory = (context: ModuleMocksContext) => ModuleMockRegistry

/**
 * The values of the dialect's per-module bindings for the module `from`, by name
 * (`LoaderOptions.moduleScope.names`). Called once per module that names a binding.
 * @public
 */
export type ModuleScopeValues = (from: ModuleId) => Readonly<Record<string, unknown>>

/**
 * Options for one test file's registry. The `process` tier is a pool decision (Track 9), so it
 * never reaches the loader.
 * @public
 */
export interface FileRegistryOptions {
  readonly tier: Exclude<IsolationTier, 'process'>
  readonly realm?: Realm
  /**
   * The file's module-mock registry, built when the file registry is. Without one nothing is
   * mocked and `registerMock` throws `LOADER_NO_MODULE_MOCKS`. Every tier gets one per file.
   */
  readonly moduleMocks?: ModuleMocksFactory
  /** The per-module bindings' values. Without it, a module that names a binding sees the global of that name. */
  readonly moduleScope?: ModuleScopeValues
}

/**
 * What `FileRegistry.registerMock` takes besides the spec.
 * @public
 */
export interface RegisterMockOptions {
  /** The module need not exist (Jest's `{ virtual: true }`). */
  readonly virtual?: boolean
  /**
   * Whether the call is a hoisted form (`jest.mock`, `vi.mock`), not a `do` form. The loader
   * doesn't act on it yet; mock-aware inlining (T2.6) reads the hoisted set.
   */
  readonly hoisted?: boolean
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
  /**
   * With no `parent`, the runner loading a setup or test file: that module itself is never mocked
   * (its imports are). With a `parent`, an import from that module, through `decide`.
   */
  import<T = unknown>(specifier: string, parent?: ModuleId | null): Promise<T>
  /** Sync; throws `ERR_REQUIRE_ASYNC_MODULE` for a graph with top-level await. No `parent` as for `import`. */
  require<T = unknown>(specifier: string, parent?: ModuleId | null): T
  /**
   * The real module, bypassing the mock of that module only; what it loads still goes through
   * `decide`, as in Jest. An ES module comes as its exports' view (`ModulePolicy.interopDefault`).
   */
  requireActual<T = unknown>(specifier: string, parent?: ModuleId | null): T
  importActual<T = unknown>(specifier: string, parent?: ModuleId | null): Promise<T>
  /** Track 4's dialect facades call these, from the module that made the call (`parent`, else the test file). */
  registerMock<T>(
    specifier: string,
    parent: ModuleId | null,
    spec: MockSpec<T>,
    options?: RegisterMockOptions,
  ): void
  unregisterMock(specifier: string, parent: ModuleId | null): void
  /** Forgets every module instance, and the module-mock values the module registry owns. */
  resetModules(): void
  /**
   * Forgets the instance of the user module `specifier` resolves to (from `parent`, else the test
   * file), so the next import or require evaluates it again. Its dependencies keep their
   * instances, and so do modules that already imported it. A specifier that resolves to a
   * node_modules package, a builtin or nothing is left alone.
   */
  invalidate(specifier: string, parent?: ModuleId | null): void
  /** A fresh instance map and module-mock overlay for `fn`'s loads. */
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
