# @provino/dialect-vitest

Provino's Vitest 5.0 dialect: Vitest's policy values, its hoisting rules, and the `.each` title formatting and pretty-format code copied from Vitest. It is not wired into a run yet: `provino vitest` is not available, and the Vitest config reader, flags and `vi` object are not built.

This package is a building block of [Provino](https://github.com/pixel-perfect-software/provino), a test runner that is pre-alpha and not on npm yet. The `provino` bundle does not include it yet, because nothing reaches it from a run.

**Versioning:** this package's public API is held to semver before 1.0: its API report is committed in the repository, under `etc/`, and a change to a `@public` signature needs a changeset.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
