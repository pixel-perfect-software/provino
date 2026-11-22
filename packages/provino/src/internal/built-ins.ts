import type { Dialect, EnvironmentRef, NativeRuntimeRefs } from '@provino/types'
import { addOnFailure, addOnSpecifier } from './add-on.ts'

/**
 * Where a worker finds an environment: an `EnvironmentRef` without the options a project adds.
 * @internal
 */
export type EnvironmentModule = Omit<EnvironmentRef, 'options'>

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
 * The native runtime (D185, D186, D188; `ResolveOptions.native`): what a project with no dialect
 * gets in place of a dialect's scope, globals and matcher table. The served `provino` module and its
 * globals come from `@provino/api`, the matchers from `@provino/expect/table` (Provino's own table,
 * B27c). Refs only: the coordinator resolves them and loads neither (D21).
 * @internal
 */
export const NATIVE_RUNTIME: NativeRuntimeRefs = {
  moduleScope: { module: import.meta.resolve('@provino/api'), export: 'provinoModuleScope' },
  globals: { module: import.meta.resolve('@provino/api'), export: 'provinoGlobals' },
  modules: ['provino'],
  matcherTable: {
    module: import.meta.resolve('@provino/expect/table'),
    export: 'provinoExpectTable',
  },
}

/**
 * The dialects `provino` ships, for a config that names one (`resolveProjects`' `loadDialects`):
 * imported only then, so a native project, `projects` of native sub-configs included, loads no
 * dialect code (D115, `speed`). The Jest dialect is an add-on (D187), resolved from `root` (the
 * config's directory) for this call; when it isn't installed there are none, so a config that only
 * looked like it might name one (a typo'd key) gets `@provino/config`'s own error.
 * @internal
 */
export async function builtInDialects(root: string): Promise<readonly Dialect[]> {
  try {
    const { jestDialect }: typeof import('@provino/dialect-jest') = await import(
      addOnSpecifier('jest', '', root)
    )
    return [jestDialect]
  } catch (error) {
    if (addOnFailure(error)?.code === 'PROVINO_DIALECT_NOT_INSTALLED') return []
    throw error
  }
}
