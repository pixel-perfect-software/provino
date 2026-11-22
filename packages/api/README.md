# @provino/api

Provino's native test API: the `provino` module a test file imports in a project with no dialect (`describe`, `it`, `test`, the four hooks, `expect`, `lazy`, `fn`, `spyOn`, `timers`, and the module mocks `mock`, `unmock` and `importActual`), and the same values as globals under `globals: true`.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner for JavaScript and TypeScript. It is private: the `provino` package inlines it, so you install `provino`, not this package.

**Status:** built. Until Provino's own matcher table is wired in, a native run needs one named by ref.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
