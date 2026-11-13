# @provino/env-jsdom

Provino's own jsdom test environment: a fresh window for each test file, put on the worker's global and removed exactly afterwards. `jsdom` (`>=26 <31`) is an optional peer dependency. This environment serves projects that use Provino's own config; a Jest project's `testEnvironment: 'jsdom'` runs the project's own `jest-environment-jsdom` instead.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package's public API is held to semver before 1.0: its API report is committed in the repository, under `etc/`, and a change to a `@public` signature needs a changeset.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
