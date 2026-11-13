# @provino/core

The test runtime that runs inside a worker: the collector and executor for `describe`, `test` and hooks, the test context and the current-test lookup. It never imports the loader, and every difference between Jest and Vitest in it is a policy value that a dialect supplies.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package is `@beta` as a whole. There is no semver promise for it before 1.0, and its API can change in any release.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
