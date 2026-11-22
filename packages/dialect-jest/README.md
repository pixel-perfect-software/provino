# @provino/dialect-jest

The Jest 30.5 dialect: Jest's policy values (each one checked against a recording of real Jest), Jest's globals and `jest` object, its `expect` matchers (copied from Jest), a config reader and a command-line parser rebuilt from `jest-config` and `jest-cli`, and the adapter that runs the Jest environment class a project names, such as `jest-environment-jsdom`. This is the package that lets `provino jest` take a Jest project's config and command line as they are.

This package is [Provino](https://github.com/pixel-perfect-software/provino)'s Jest add-on: install it beside [`provino`](https://www.npmjs.com/package/provino), which it names as a peer and whose engine it runs on, to run a Jest project with `provino jest`. It carries the Jest packages its matchers and messages use (`pretty-format`, `jest-matcher-utils` and the rest, and Babel for inline snapshots), so a project without it installs none of them.

```bash
pnpm add -D provino@rc @provino/dialect-jest@rc
```

**Versioning:** this package's public API is held to semver before 1.0: its API report is committed in the repository, under `etc/`, and a change to a `@public` signature needs a changeset.

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE)
