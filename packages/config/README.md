# @provino/config

Loads a project's config file and resolves it, with a dialect's policy values, into the project the coordinator and its workers run: the dialect, the policy, the test file globs, the environment, the isolation tier and the config each worker is given. It names no dialect and no environment package: the caller supplies them.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package is `@beta` as a whole. There is no semver promise for it before 1.0, and its API can change in any release.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
