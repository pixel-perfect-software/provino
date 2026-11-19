# @provino/reporters

The reporter bus and the built-in reporters: `default`, `verbose`, `dot`, `agent`, `json` (also named `normalized-json`), `junit` and `github-actions`.

Two more reporters are entries of their own, loaded only when a run chooses them:

- `@provino/reporters/live`: the `provino` reporter, Provino's own terminal output (a live footer of the busy workers, a line for each file as it ends, failures with a code frame, an end card, and the `--tree` and `--map` views).
- `@provino/reporters/html`: the `html` reporter, one self-contained page written when the run ends.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner for Jest projects, on npm as [`provino`](https://www.npmjs.com/package/provino). The `provino` package ships every `@provino/*` package inlined in one bundle, so you install `provino`, not this package.

**Versioning:** this package is `@beta` as a whole. There is no semver promise for it before 1.0, and its API can change in any release.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
