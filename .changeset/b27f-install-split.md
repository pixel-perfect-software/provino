---
"provino": minor
"@provino/dialect-jest": minor
"@provino/dialect-vitest": minor
---

The dialects are add-on installs. `provino` no longer bundles `@provino/dialect-jest` or `@provino/dialect-vitest`, nor their Jest, Babel and Chai packages: install `@provino/dialect-jest` beside `provino`, at `provino`'s own version, to run `provino jest` (`pnpm add -D @provino/dialect-jest@<the provino version>`), and `@provino/dialect-vitest` for `provino vitest`. Without the add-on, or with one of another version, the command prints that install line, the version filled in, and exits 1 (`PROVINO_DIALECT_NOT_INSTALLED`, `PROVINO_DIALECT_VERSION_MISMATCH`). The add-on is resolved from the project's own install. Each dialect names `provino` as a peer and runs on its engine through `provino/internal/*` subpaths, which are internal and promise no semver. A project that uses only `provino.config` installs nothing from Jest or Vitest.
