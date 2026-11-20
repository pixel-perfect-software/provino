# @provino/api

Provino's native test API: the `provino` module a test file imports in a project with no dialect (`describe`, `it`, `test`, the four hooks, `expect`, `lazy`, `fn`, `spyOn`, `timers`), and the same values as globals under `globals: true`.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner for JavaScript and TypeScript. It is private: the `provino` package inlines it, so you install `provino`, not this package.

**Status:** a scaffold. Every export throws `API_NOT_BUILT` until the native API is built.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
