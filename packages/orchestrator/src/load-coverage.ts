// The coordinator's coverage store, loaded on demand: it brings `@provino/coverage/node`, which a run
// without coverage never loads (T1.10, T7.12). `runProjects` imports it the same way.

/**
 * The module of `createRawCoverageStore`, loaded on demand.
 * @public
 */
export function loadCoverageStore(): Promise<typeof import('./coverage-store.ts')> {
  return import('./coverage-store.ts')
}
