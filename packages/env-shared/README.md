# @provino/env-shared

What the DOM environments share: `populateGlobal`, which puts a window's properties on the worker's global with Vitest 5.0's semantics, and an exact restore of the global afterwards. The Node environment and the Jest environment adapter use the restore too.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package is `@beta` as a whole. There is no semver promise for it before 1.0, and its API can change in any release.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
