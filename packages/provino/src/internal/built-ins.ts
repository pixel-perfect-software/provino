import type { Dialect, EnvironmentRef, NativeRuntimeRefs } from '@provino/types'
import { DialectNotInstalledError, importAddOn } from './add-on.ts'

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
 * dialect code (D115, `speed`). The Jest dialect is an add-on since B27f (D187): when it isn't
 * installed `load` gives none, so a config that only looked like it might need one (a typo'd key)
 * gets `@provino/config`'s own error, and `missing` says the add-on was asked for and absent
 * (`run()` turns an error about `jest` into the install line then).
 * @internal
 */
export function builtInDialects(): {
  readonly load: () => Promise<readonly Dialect[]>
  readonly missing: () => boolean
} {
  let absent = false
  return {
    async load() {
      try {
        const { jestDialect } = await importAddOn('jest', () => import('@provino/dialect-jest'))
        return [jestDialect]
      } catch (error) {
        if (!(error instanceof DialectNotInstalledError)) throw error
        absent = true
        return []
      }
    },
    missing: () => absent,
  }
}
