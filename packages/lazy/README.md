# @provino/lazy

Lazy variables: values defined with `lazy.let`, typed by chaining, evaluated on first read and memoized for the test. Overrides in a nested `describe` replace a value for that suite, and `parent()` reaches the one it replaced.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package has no semver promise before 1.0 (D82), and its API can change in any release.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
