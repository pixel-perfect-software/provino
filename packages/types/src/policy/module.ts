import type { Behaviour } from './behaviour.ts'

/**
 * Error texts the module-mock registry prints, by message code. `@provino/mock` defines the codes
 * (`module-missing`, `factory-not-object`, `missing-factory-export`, `nested-isolation`, ...) and
 * the neutral text; a dialect's value overrides any of them. `{specifier}`, `{from}`, `{name}`
 * and `{raw}` are filled in.
 * @public
 */
export interface ModuleMessages {
  readonly [code: string]: string
}

/**
 * What a name-mapper rule that matched with no target resolving gives the dialect to word:
 * `specifier` as written, `rule` the rule's regular expression as text, `declared` the targets as
 * configured, `tried` what each resolved to, and `resolver` the project's custom resolver (as the
 * config names it; `undefined` when there is none).
 * @public
 */
export interface MapperMiss {
  readonly specifier: string
  readonly rule: string
  readonly declared: readonly string[]
  readonly tried: readonly string[]
  readonly resolver: string | undefined
}

/**
 * The text of a name-mapper miss. A behaviour, not a template: how a list of targets is laid out
 * is the runner's.
 * @public
 */
export type FormatMapperMiss = (miss: MapperMiss) => string

/**
 * The `module` slice, read by `@provino/loader` (Track 2) and `@provino/mock` (Track 4): module
 * mocks, interop and registry resets. Track 2's `LoaderPolicy` and Track 4's `ModuleMockPolicy`,
 * merged under Track 1's names.
 *
 * Hoisting is per dialect, not here: see `Dialect.loader.hoist`.
 * @public
 */
export interface ModulePolicy {
  /**
   * What a `jest.mock`/`vi.mock` factory returns. Also Track 4's `factoryResult` and Track 11's
   * `moduleFactoryResult`. Track 1 lists it as behaviour; Track 4's data form is used.
   * Jest: `module-value` (returns `module.exports`). Vitest: `namespace` (needs `default`).
   * research: track-01 L207, track-04 L308
   */
  readonly factoryShape: 'module-value' | 'namespace'
  /**
   * Whether root `__mocks__` beside `node_modules` apply without a mock call. Replaces Track 1's
   * `rootMocksDir` (§6). Jest: `true`. Vitest: `false`. research: track-02 L453, track-04 L311
   */
  readonly rootMocksAutoApply: boolean
  /** Whether every module is automocked. Also Track 4's `automockAll`. Jest: `false`. Vitest: n/a (`false`). research: track-01 L209 */
  readonly automock: boolean
  /** How the real module is loaded inside a mock. Jest: `sync-require`. Vitest: `async-import`. research: track-01 L210 */
  readonly actual: 'sync-require' | 'async-import'
  /** Whether the module registry resets between tests. Jest: `false`. Vitest: `false`. research: track-01 L213 */
  readonly resetModulesBetween: boolean
  /** Whether CJS globals (`require`, `module`, `__dirname`) are injected. Jest: `true`. Vitest: `true`. research: track-01 L214 */
  readonly injectCjsGlobals: boolean
  /**
   * The module shapes the runner hands out, `babel` (modules compiled by Babel's CommonJS interop)
   * or `node` (Node's ES namespaces). It decides:
   * - `import x from 'cjs'`: `exports.default` when the value has `__esModule` (`babel`), else
   *   `module.exports` (always, for `node`);
   * - a CommonJS value seen as a namespace: `default` first and then the value's own keys (`babel`;
   *   a value with `__esModule` is its own namespace), or every key sorted by name with `default`
   *   among them and `Symbol.toStringTag` `Module` (`node`);
   * - a source ES module's exports (`requireActual`, `importActual`, what an automock walks): a
   *   non-enumerable `__esModule` and the names sorted (`babel`), or a `Module` namespace in source
   *   order (`node`).
   *
   * Jest: `babel`. Vitest: `node`. research: track-02 L452 (mod corpus agrees for both)
   */
  readonly interopDefault: 'babel' | 'node'
  /** Whether `resetModules()` also clears registered mocks. Jest: `false`. Vitest: `false`. research: track-02 L454 */
  readonly resetModulesClearsMocks: boolean
  /** Whether a mock factory's promise is awaited. Jest: `false`. Vitest: `true`. research: track-04 L309 */
  readonly awaitFactory: boolean
  /**
   * A mocked module reached on the sync path (a `require`, or an ES module a `require` evaluates)
   * when `awaitFactory` would make it a Promise. `settle`: a factory whose result is no thenable is
   * the module at once, and an automock or manual mock loads through the sync actual path; a
   * factory that returns a thenable, or a graph with top-level await, is still refused by name.
   * `refuse`: every such mock is refused ("its mock is asynchronous"). Provino's own key (D7), read
   * only under `awaitFactory`. Neutral: `settle`. Jest and Vitest: `refuse` (nothing changes there).
   */
  readonly syncMocks: 'settle' | 'refuse'
  /** Reading an export the factory didn't return. Values: B14 records them. research: track-04 L310 */
  readonly missingFactoryExport: 'undefined' | 'throw'
  /** Whether mocking a module that doesn't exist needs a `virtual` flag. Jest: `true`. Vitest: `false`. research: track-04 L313 */
  readonly requireVirtualFlag: boolean
  /**
   * Whether a mock can stand in for a relative path that isn't on disk. When `false`, the mock is
   * accepted but importing the path fails with the `unresolved-relative-mock` text; a bare name is
   * unaffected. Jest: `true` (with `virtual`). Vitest: `false`. research: mod corpus `mod-missing`,
   * `mod-virtual`, `mod-virtual-static`
   */
  readonly virtualRelative: boolean
  /**
   * Who owns the value a mock factory built, which decides two things at once:
   * - `module-registry` (Jest): the value lives in the module registry
   *   (`ModuleRegistries.mockRegistry`), so `resetModules()` clears it and the factory runs again
   *   on the next load, while registering an id again leaves it: the next load still sees the first
   *   factory's value until a reset.
   * - `registration` (Vitest): the value lives on the registered mock
   *   (`ManualMockedModule.cache`), so registering an id again replaces it with the new
   *   registration's, while `resetModules()` skips mocks (`/^mock:/`) and keeps it.
   *
   * Jest: `module-registry`. Vitest: `registration`. Recorded by `mod-reregister` and
   * `mod-reset-modules` (Jest 30.5.2, Vitest 5.0.5).
   */
  readonly mockValueOwner: 'module-registry' | 'registration'
  /**
   * How an automock is built: from module metadata (`metadata`), or by walking the exports deeply
   * (`deep`). Track 4 names the values `'jest-metadata' | 'vitest'`; renamed so neutral code never
   * compares a runner name. Jest: `metadata`. Vitest: `deep`. research: track-04 L314
   */
  readonly automockShape: 'metadata' | 'deep'
  /**
   * The kind a mock call's specifier resolves as, which decides the package `exports` conditions
   * it is looked up with: `require` (the `require` condition) or `import` (the `import` one). A
   * package that only has the other condition is not found, and a mock of it is refused or
   * treated as a virtual one by `requireVirtualFlag`. Jest: `require`. Vitest: `import`.
   * Recorded by `mod-conditions` (Jest 30.5.2, Vitest 5.0.5).
   */
  readonly mockResolveKind: 'require' | 'import'
  /**
   * The kind a module's edges resolve as, which decides the package `exports` conditions they are
   * looked up with. `as-written`: each edge is its own kind, an `import` or `import()` adds the
   * `import` condition and a `require` the `require` one. `importer-format`: every edge of a module
   * takes the kind of the module it is in, `import` for one the runner runs as an ES module and
   * `require` for any other, whatever its syntax; a module runs as an ES module when Node has
   * `vm.SyntheticModule` (`--experimental-vm-modules`) and the file is `.mjs`, a `.js` file whose
   * nearest `package.json` has `"type": "module"`, or has an extension in the loader's
   * `esmExtensions`. `import.meta.resolve` keeps its own kind under either. An edge that finds no
   * file under its importer's kind (a package with only an `import` entry) is not found, as in
   * Jest, so a virtual mock or a name mapper can still stand in for it; `provino` itself has a
   * `default` entry beside its `import` one for that reason.
   *
   * Jest: `importer-format`, as jest-runtime resolves every edge of a module it runs as CommonJS
   * with its CJS conditions (an `import` its transform turned into `require` too) and every edge of
   * an ES module with its ESM ones (`jest-runtime` `internals/Resolution.ts`, `shouldLoadAsEsm` in
   * `jest-resolve`); recorded by `env/conditions-import-node`, `-jsdom`, `-custom` and `-esm`
   * (Jest 30.5.2). Vitest: `as-written`, pending T11.16. Neutral: `as-written` (speed: no format
   * lookup per importer).
   */
  readonly edgeResolveKind: 'as-written' | 'importer-format'
  /**
   * Whether an edge's lookup adds the `module-sync` export condition (a dual package's entry an ES
   * module and `require(esm)` can both load). `never`: no edge adds it. `import-and-sync-require`:
   * an edge that resolves as `import` (an `import`, `import()` or `import.meta.resolve`, and every
   * edge of a module run as an ES module under `edgeResolveKind: 'importer-format'`) adds it, and
   * one that resolves as `require` adds it only when the runtime can evaluate an ES module graph
   * synchronously (`vm.SourceTextModule.prototype.hasAsyncGraph`: Node 24.9 and later, under
   * `--experimental-vm-modules`). A mock registration resolves by the same rule, so its id is the
   * edge's.
   *
   * Jest: `import-and-sync-require`, as jest-runtime builds its ESM conditions with `module-sync`
   * and its CJS ones with it only when `supportsSyncEvaluate` (`internals/Resolution.ts` L35-48,
   * `nodeCapabilities.ts`); recorded by `env/conditions-import-module-sync` (Jest 30.5.2). Vitest:
   * `never`, pending T11.16. Neutral: `never` (speed: no capability probe, as before).
   */
  readonly moduleSyncCondition: 'never' | 'import-and-sync-require'
  /**
   * Whether a mock reaches the modules in `node_modules` that import the mocked one (T2.6, D39). When
   * `true`, a package whose imports lead to a module the file mocks is loaded per file through that
   * file's registry (inlined), so the mock reaches it; the next file sees the shared module. When
   * `false`, such a package stays shared, loaded natively, and sees the real module.
   *
   * Jest: `true`, as jest-runtime's registry loads every module, node_modules included, through
   * `requireModuleOrMock`. Vitest: `false`, as externalized dependencies load natively. Recorded
   * by `mod-shared-dep` and `mod-shared-dep-root` (Jest 30.5.2, Vitest 5.0.5). Neutral: `true`.
   */
  readonly mocksReachShared: boolean
  /**
   * Whether a shared node_modules package that reads a per-file global while it first loads is
   * evaluated again in each later test file (D127, P42). When `true`, the worker watches each
   * package's first native load from a user module or the runner: one that reads a test global
   * (a hook, `jest`, `expect`, …) or a global the file's environment installed (`document`,
   * `window`, …) is, with the modules that load did, loaded through each later file's registry
   * (inlined), so its top-level code binds that file's globals. What a worker learns is kept in the
   * results cache. When `false`, every such package stays shared, loaded natively once per worker.
   * A no-op under isolation `none`, where no file is evaluated again by design.
   *
   * Jest: `true`, as jest-runtime evaluates node_modules again in every test file's registry;
   * recorded by `ecosystem/rtl-cleanup` and `ecosystem/jest-canvas-mock` (Jest 30.5.2). Vitest:
   * `true`, as each isolated file evaluates an externalized package again; recorded by
   * `module/vitest-externals-two-files` (Vitest 5.0.5). Neutral: `false`
   * (speed: one evaluation per worker).
   */
  readonly reevaluateHookingExternals: boolean
  /**
   * Whether a shared external whose first load, while a test file runs, adds a key to the global or
   * replaces one is evaluated per file from the next file on, with what that load evaluated, as
   * the externals `reevaluateHookingExternals` learns are. The environment's restore takes such a
   * key away after the file, and a shared copy never writes it again (msw's interceptors add the
   * context they mark their own connections with). An accessor that became a data key (a lazy
   * global's first read) and a deleted key are not writes. When `false`, writes are not watched. A
   * no-op under isolation `none`.
   *
   * Jest: `true`, as jest-runtime evaluates a package again on every file's fresh global; recorded
   * by `ecosystem/load-time-global`, `ecosystem/msw-setup-file` and `ecosystem/msw-node` (Jest
   * 30.5.2). Vitest: `true`, recorded by `module/vitest-externals-two-files` (Vitest 5.0.5).
   * Neutral: `false` (speed: one evaluation per worker,
   * and no second walk of the global per watched load).
   */
  readonly reevaluatePatchingExternals: boolean
  /** Paths `automock` leaves real (Jest `unmockedModulePathPatterns`). Jest: `[]`. Vitest: `[]`. research: track-04 L316 */
  readonly unmockedPathPatterns: readonly RegExp[]
  /**
   * What a failing frame in a transformed file is called. `mapped-name`: the name the file's source
   * map holds at the frame's own position (the identifier called there), so a failed matcher's
   * frame reads `at Object.toBe (x.test.ts:6:15)`, as Jest's source-map support does. `engine`: the
   * name V8 gave the frame (`at Object.<anonymous>`). Jest: `mapped-name`, recorded by
   * `cli/failure-frames` (DV88). Vitest: `engine`, not recorded yet (T11.16). Neutral: `engine`.
   */
  readonly stackFrameNames: 'mapped-name' | 'engine'
  /**
   * What a shared external's native load sees of the patches the process's own code made to
   * Node's CommonJS loader (`Module.prototype.require`, `Module._load`, `Module._resolveFilename`;
   * Next.js's require hook, which next/jest's config and transformer install, patches two). `apply`:
   * the loader as it is, so the external's own `require`s go through them, as Node has it. `skip`:
   * the load runs with the three as Provino found them when it started, so no patch made outside
   * the test files reaches a test file's modules, as jest-runtime loads them itself and never calls
   * Node's loader (`require`s a module makes later, outside its load, are not covered). Jest:
   * `skip`, recorded by `cli/module-patch-outer-realm` (Jest 30.5.2). Vitest: `apply`, not recorded
   * (T11.16: an externalized dependency loads through Node). Neutral: `apply`.
   */
  readonly nativeLoadPatches: 'apply' | 'skip'
  /**
   * The registry's error texts, by code. Empty means the neutral text. Jest's come from
   * jest-runtime's `MockState.ts` and jest-resolve; Vitest's from `@vitest/mocker`.
   */
  readonly messages: ModuleMessages
  /**
   * The text of a name-mapper rule that matched with no target resolving, or `null` for none: the
   * miss is then a `module-not-found`. Jest: jest-resolve's configuration error
   * (`createNoMappedModuleFoundError`), recorded by `resolve/mapper-miss`. Vitest: `null`.
   */
  readonly mapperMiss: Behaviour<FormatMapperMiss> | null
}
