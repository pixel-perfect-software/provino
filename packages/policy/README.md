# @provino/policy

The policy runtime: the neutral defaults, layering a dialect's values over them, `defineDialect`, loading behaviour by reference, serializing a policy for a worker and diffing two policies. A policy is a set of typed values for the places where Jest and Vitest behave differently.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package is `@beta` as a whole. There is no semver promise for it before 1.0, and its API can change in any release.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
