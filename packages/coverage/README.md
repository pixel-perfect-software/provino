# @provino/coverage

Code coverage: the Istanbul instrumenter and the V8 collectors that run in a worker, and the merge, reports and thresholds that run in the coordinator. A dialect supplies the words and the rules for the numbers.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package is `@beta` as a whole. There is no semver promise for it before 1.0, and its API can change in any release.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
