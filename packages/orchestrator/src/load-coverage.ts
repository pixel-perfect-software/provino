// The coordinator's coverage store and its finish, loaded on demand: they bring `@provino/coverage`
// and its `/node` entry, which a run without coverage never loads (T1.10, T7.12). `runProjects`
// imports them the same way.

/**
 * The module of `createRawCoverageStore`, loaded on demand.
 * @public
 */
export function loadCoverageStore(): Promise<typeof import('./coverage-store.ts')> {
  return import('./coverage-store.ts')
}

/**
 * The module of `finishCoverage`, loaded on demand.
 * @public
 */
export function loadFinishCoverage(): Promise<typeof import('./coverage.ts')> {
  return import('./coverage.ts')
}
