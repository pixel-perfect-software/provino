---
"provino": minor
"@provino/dialect-jest": minor
"@provino/dialect-vitest": minor
---

The dialects are add-on installs. `provino` no longer bundles `@provino/dialect-jest` or `@provino/dialect-vitest`, nor their Jest, Babel and Chai packages: install `@provino/dialect-jest` beside `provino` to run `provino jest` (`pnpm add -D provino @provino/dialect-jest`), and `@provino/dialect-vitest` for `provino vitest`. Without the add-on, the command prints that install line and exits 1. Each dialect names `provino` as a peer and runs on its engine through `provino/internal/*` subpaths, which are internal and promise no semver. A project that uses only `provino.config` installs nothing from Jest or Vitest.
