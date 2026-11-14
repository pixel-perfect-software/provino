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
