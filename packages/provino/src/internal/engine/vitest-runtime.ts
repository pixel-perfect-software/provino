// `provino/internal/vitest-runtime` (D187): `@provino/dialect-vitest`'s engine imports, reached through the add-on's `provino` peer so
// an install holds one copy of the engine. The add-on's build rewrites its `@provino/*` imports to
// this subpath (`tooling/packaging/src/internal-entries.ts`). Internal: no semver promise, for the
// add-ons only. Values are named one by one, the names the add-on imports
// (`packages/provino/test/exports.test.ts` fails on one it lacks): `export *` would keep whole
// packages in the graph and move worker-only engine code into `shared.js`, which the coordinator
// loads too. Types are whole packages: they cost nothing at run time.

export type * from '@provino/core'
export type * from '@provino/env-jsdom'
export { jsdomEnvironment } from '@provino/env-jsdom'
export type * from '@provino/env-shared'
export { leakReport, populateGlobal, snapshotProperties, WINDOW_KEYS } from '@provino/env-shared'
export type * from '@provino/expect'
export { policyMessages, snapshotMatchers } from '@provino/expect'
export type * from '@provino/mock'
export { automock, createMockFn, createStubs, isMockFunction, spyOn } from '@provino/mock'
// The policy package whole: naming its values here is what the `slice-discipline` lint refuses in
// `provino` (`defineDialect` hands out the whole `Policy`), and it adds nothing `shared.js` lacks.
export * from '@provino/policy'
export type * from '@provino/resolver'
export { createResolver } from '@provino/resolver'
export type * from '@provino/timers'
export { createTimerMembers } from '@provino/timers'
