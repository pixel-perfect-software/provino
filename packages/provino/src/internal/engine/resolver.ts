// `provino/internal/resolver` (D187): `@provino/dialect-jest/node`'s resolution, reached through the add-on's `provino` peer so
// an install holds one copy of the engine. The add-on's build rewrites its `@provino/*` imports to
// this subpath (`tooling/packaging/src/internal-entries.ts`). Internal: no semver promise, for the
// add-ons only.
export * from '@provino/resolver'
