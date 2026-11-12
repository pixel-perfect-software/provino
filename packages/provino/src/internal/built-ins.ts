import type { EnvironmentRef } from '@provino/types'

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
