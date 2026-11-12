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
}
