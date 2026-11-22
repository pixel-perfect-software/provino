// `provino/internal/config` (D187): `@provino/dialect-vitest`'s config loading, reached through the add-on's `provino` peer so
// an install holds one copy of the engine. The add-on's build rewrites its `@provino/*` imports to
// this subpath (`tooling/packaging/src/internal-entries.ts`). Internal: no semver promise, for the
// add-ons only.
// Only what the add-on uses: the whole package here would split the transform's cache store out of
// the bin's light files into a chunk of its own, one more file in every worker's cold start.
export { ConfigError, importConfigModule } from '@provino/config'
