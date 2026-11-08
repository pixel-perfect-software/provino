// Track 3 §Hoist policy (track-03 L369), unchanged. Dialects supply it through
// `Dialect.loader.hoist`; @provino/transform applies every served dialect's policy to a file.

/**
 * Which arguments a hoisted call accepts. `path-factory-options` is `(path, factory?, options?)`
 * with a literal path (Track 3 calls it `'jest-mock'`; renamed so neutral code never names a
 * runner).
 * @public
 */
export type HoistArgRule = 'any' | 'one-string' | 'no-args' | 'path-factory-options'

/**
 * How a mock object is recognised: an unshadowed global (`jest`), any binding with a name
 * (`vi`), a named import, or a member of a namespace import.
 * @public
 */
export type MockObjectMatcher =
  | { readonly kind: 'global'; readonly name: string }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'import'; readonly module: string; readonly exportName: string }
  | { readonly kind: 'namespace-member'; readonly module: string; readonly exportName: string }

/**
 * Which outside names a hoisted mock factory may reference.
 * @public
 */
export interface FactoryReferenceRule {
  readonly allowGlobals: ReadonlySet<string>
  /** Jest: `/^mock/i`, plus `/^(?:__)?cov/` for coverage variables. */
  readonly allowPattern: RegExp
  /** Jest: `true`. */
  readonly hoistPureConsts: boolean
}

/**
 * The hoisting violations a policy words for itself, each one a `TransformErrorCode`.
 * @public
 */
export type HoistErrorCode =
  | 'HOIST_FACTORY_OUT_OF_SCOPE'
  | 'HOIST_NOT_TOP_LEVEL'
  | 'HOIST_NESTED'
  | 'HOIST_EXPORTED'
  | 'HOIST_FACTORY_NOT_FUNCTION'

/**
 * What a dialect's mock hoisting does. Replaces Track 1's `module.hoistNames` (now `objects`) and
 * `module.nonTopLevelMock` (now `placement`). Jest/Vitest values: track-03 L612 (unverified).
 * @public
 */
export interface HoistPolicy<Calls extends string = string, Values extends string = string> {
  /** Part of the transform cache fingerprint. */
  readonly id: string
  readonly objects: readonly MockObjectMatcher[]
  readonly hoistCalls: { readonly [M in Calls]: HoistArgRule }
  /** `['hoisted']` for Vitest, `[]` for Jest. */
  readonly hoistValues: readonly Values[]
  /**
   * Calls whose `import('./x')` argument is rewritten to `'./x'`. Any of them on a mock object also
   * makes the file's imports `await import()`, even if nothing hoists (Vitest's `hasMockApiCall`).
   */
  readonly rewriteImportArg: readonly string[]
  /** Whether calls chain (`jest.mock(a).mock(b)`). */
  readonly chainable: boolean
  readonly placement: 'enclosing-block' | 'top-level-only'
  /** Guards hoisting may sit under, e.g. `['import.meta.vitest']`. */
  readonly topLevelGuards: readonly string[]
  readonly factoryReferences: 'allow' | FactoryReferenceRule
  /** Imports kept first: `['@jest/globals']` / `['vitest']`. */
  readonly runnerModules: readonly string[]
  /**
   * What happens to `export … from` (including `export *`) when a call hoists to the top of a
   * file. `'in-order'` loads each in source order with the imports, after the hoisted block (Babel's
   * CJS step keeps source order, so Jest's mocks apply to re-exports). `'static'` leaves them as
   * written, as Vitest's `hoistMocks.ts` rewrites only `ImportDeclaration`; the module-runner
   * transform then moves them above the mocks, so a re-exported module loads before mocks exist.
   */
  readonly reExports: 'in-order' | 'static'
  /**
   * The `this` a call through a rewritten import gets, when the import was a named or default
   * binding: `f()` and `` f`x` ``. `'detached'` writes `(0, ns.f)()`, so `this` is `undefined`, as
   * Babel's CJS step does. `'member'` writes `ns.f()`, so `this` is the namespace, as Vitest's
   * `hoistMocks.ts` does.
   */
  readonly rewrittenCalls: 'detached' | 'member'
  /**
   * The text of each violation, copied exactly from the upstream the dialect mirrors. `{call}` is
   * the call as written (`jest.mock`) and `{name}` the offending identifier, where one exists.
   * `HOIST_NESTED` is the exception: there `{call}` is the inner call and `{name}` the outer one,
   * each with its argument (`vi.mock('./a')`). `HOIST_EXPORTED_VALUE` is `HOIST_EXPORTED`'s text
   * when what was exported is one of `hoistValues` rather than a call that returns nothing.
   */
  readonly messages: { readonly [Code in HoistErrorCode]: string } & {
    readonly HOIST_EXPORTED_VALUE: string
  }
}
