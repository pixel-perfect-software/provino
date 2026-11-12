/**
 * The adapter a Jest project's own environment class (D44) runs through; its options name the class.
 * @internal
 */
export const JEST_ENVIRONMENT: { readonly module: string; readonly export: string } = {
  module: import.meta.resolve('@provino/dialect-jest/runtime'),
  export: 'jestEnvironment',
}

/**
 * The environments `provino` ships, by name, as the absolute refs a worker imports.
 * @internal
 */
export const ENVIRONMENTS: Readonly<
  Record<string, { readonly module: string; readonly export: string }>
> = {
  node: { module: import.meta.resolve('@provino/env-node'), export: 'nodeEnvironment' },
  jsdom: { module: import.meta.resolve('@provino/env-jsdom'), export: 'jsdomEnvironment' },
}

/**
 * The environments a Jest project may name without the adapter: `node` only. A Jest project's
 * `jsdom` is its own `jest-environment-jsdom` through the adapter (D44); `@provino/env-jsdom`
 * serves `provino.config` and neutral projects.
 * @internal
 */
export const JEST_BUILT_INS: Readonly<
  Record<string, { readonly module: string; readonly export: string }>
> = { node: ENVIRONMENTS.node as { readonly module: string; readonly export: string } }
