# @provino/snapshot

The snapshot engine: the `.snap` file format, the per-file state machine, and the coordinator's update mode and totals. A dialect supplies the printer and the words.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package is `@beta` as a whole. There is no semver promise for it before 1.0, and its API can change in any release.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
