// Track 3 §Hoist policy (track-03 L369), unchanged. Dialects supply it through
// `Dialect.loader.hoist`; @provino/transform applies every served dialect's policy to a file.

/**
 * Which arguments a hoisted call accepts.
 * @public
 */
export type HoistArgRule = 'any' | 'one-string' | 'no-args' | 'jest-mock'

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
  /** Calls whose `import('./x')` argument is rewritten to `'./x'`. */
  readonly rewriteImportArg: readonly string[]
  /** Whether calls chain (`jest.mock(a).mock(b)`). */
  readonly chainable: boolean
  readonly placement: 'enclosing-block' | 'top-level-only'
  /** Guards hoisting may sit under, e.g. `['import.meta.vitest']`. */
  readonly topLevelGuards: readonly string[]
  readonly factoryReferences: 'allow' | FactoryReferenceRule
  /** Imports kept first: `['@jest/globals']` / `['vitest']`. */
  readonly runnerModules: readonly string[]
}
