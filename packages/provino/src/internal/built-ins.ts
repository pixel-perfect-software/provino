import type {
  EnvironmentRef,
  MatcherTableFactory,
  ModuleRef,
  NativeRuntimeRefs,
} from '@provino/types'

/** Where a worker finds an environment: an `EnvironmentRef` without the options a project adds. */
type EnvironmentModule = Omit<EnvironmentRef, 'options'>

/**
 * The adapter a Jest project's own environment class (D44) runs through; its options name the class.
 * @internal
 */
export const JEST_ENVIRONMENT: EnvironmentModule = {
  module: import.meta.resolve('@provino/dialect-jest/runtime'),
  export: 'jestEnvironment',
}

/**
 * The Node environment, which every project may name.
 * @internal
 */
export const NODE_ENVIRONMENT: EnvironmentModule = {
  module: import.meta.resolve('@provino/env-node'),
  export: 'nodeEnvironment',
}

/**
 * The environments `provino` ships, by name, as the absolute refs a worker imports.
 * @internal
 */
export const ENVIRONMENTS: Readonly<Record<string, EnvironmentModule>> = {
  node: NODE_ENVIRONMENT,
  jsdom: { module: import.meta.resolve('@provino/env-jsdom'), export: 'jsdomEnvironment' },
}

/**
 * The environments a Jest project may name without the adapter: `node` only. A Jest project's
 * `jsdom` is its own `jest-environment-jsdom` through the adapter (D44); `@provino/env-jsdom`
 * serves `provino.config` and neutral projects.
 * @internal
 */
export const JEST_BUILT_INS: Readonly<Record<string, EnvironmentModule>> = {
  node: NODE_ENVIRONMENT,
}

/**
 * The native runtime's served module and globals (D185, D186), from `@provino/api`: what a project
 * with no dialect gets in place of a dialect's scope and globals. The matcher table is `nativeRuntime`'s.
 * @internal
 */
export const NATIVE_API: Omit<NativeRuntimeRefs, 'matcherTable'> = {
  moduleScope: { module: import.meta.resolve('@provino/api'), export: 'provinoModuleScope' },
  globals: { module: import.meta.resolve('@provino/api'), export: 'provinoGlobals' },
  modules: ['provino'],
}

/**
 * The variable that names the native runtime's matcher table as `<absolute module>#<export>`, until
 * B27e wires `@provino/expect/table` (B27c builds it) in its place and removes the variable.
 * @internal
 */
export const NATIVE_TABLE_VARIABLE = 'PROVINO_NATIVE_MATCHER_TABLE'

/**
 * The native runtime's refs (`ResolveOptions.native`), or `undefined` while there is no matcher table
 * to give it: today only a table named by `PROVINO_NATIVE_MATCHER_TABLE` (the tests' fixture table).
 * Without one, a project with no dialect resolves as before (`matcherTable: null`).
 * @internal
 */
export function nativeRuntime(env: NodeJS.ProcessEnv): NativeRuntimeRefs | undefined {
  const named = env[NATIVE_TABLE_VARIABLE]
  if (named === undefined || named === '') return undefined
  const at = named.lastIndexOf('#')
  const matcherTable: ModuleRef<MatcherTableFactory> =
    at <= 0
      ? { module: named, export: 'default' }
      : { module: named.slice(0, at), export: named.slice(at + 1) }
  return { ...NATIVE_API, matcherTable }
}
