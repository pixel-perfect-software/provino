/**
 * The environments `provino` ships, by name, as the absolute refs a worker imports.
 * @internal
 */
export const ENVIRONMENTS: Readonly<
  Record<string, { readonly module: string; readonly export: string }>
> = {
  node: { module: import.meta.resolve('@provino/env-node'), export: 'nodeEnvironment' },
}
