<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pixel-perfect-software/provino/main/assets/provino-mark.png">
    <img src="https://raw.githubusercontent.com/pixel-perfect-software/provino/main/assets/provino-logo.png" alt="Provino" height="80">
  </picture>
</p>

# provino

A test runner for JavaScript and TypeScript, for Node. One neutral core runs the tests, and Jest and Vitest are dialects on top of it. Today `provino jest` runs a Jest project: it reads the project's Jest config and command line, and runs its tests.

**Pre-alpha, and not published to npm yet.** This package is the one you install: it holds every `@provino/*` package inlined in one bundle, with the `provino` command. Until the first release, install it from a tarball built from [the repository](https://github.com/pixel-perfect-software/provino).

## Install

You need Node 22.15 or later (24 recommended) and pnpm. Build the tarball once:

```sh
git clone https://github.com/pixel-perfect-software/provino.git
cd provino
pnpm install
pnpm pack:all --out ~/provino-packs
```

Then, in your Jest project:

```sh
pnpm add -D ~/provino-packs/provino-0.0.0.tgz
```

## Use

```sh
pnpm exec provino jest --listTests              # the test files it would run
pnpm exec provino jest path/to/one.test.ts      # one file first
pnpm exec provino jest                          # the whole suite
```

`provino jest` takes Jest's own command line and the Jest config found from the working directory (or `-c`/`--config`), and exits with Jest's exit codes. A flag it can't run yet is refused by name. `provino --help` lists the commands.

## What works

Jest's config and command line; several `projects` in one pool; TypeScript, TSX, JSX and JavaScript tests (compiled with Oxc, not type-checked); the project's own transformers (`babel-jest`, `ts-jest`, `@swc/jest`); `moduleNameMapper`; `node`, `jsdom` and custom environments, through the project's own environment class; `globalSetup` and `globalTeardown`; Jest's globals, `expect` matchers, mocks and automock, modern fake timers, `@jest/globals`, `jest.retryTimes`; snapshots in Jest's format; `--bail`, `--shard`, `--forceExit`, `--detectOpenHandles` and Ctrl+C handling; and the `default`, `verbose`, `agent` and `github-actions` reporters.

## What's not in place yet

- Coverage (`--coverage`), watch mode (`--watch`), `--json` and `--outputFile` for a run, custom reporters (`--reporters`), running only changed files, random test order and `--detectLeaks` are refused by name.
- Inline snapshots (`toMatchInlineSnapshot`) compare, but can't write a new one.
- Legacy fake timers throw.
- `provino vitest` is not available, and the RSpec-style lazy variables are not built.

The repository's [README](https://github.com/pixel-perfect-software/provino#readme) has the full list, with what happens for each. There are no benchmark results yet.

## Reporting a problem

If Provino and Jest disagree on a test, please [open an issue](https://github.com/pixel-perfect-software/provino/issues) with the test (or a minimal copy), Jest's result, Provino's result, and the output of `provino jest --showConfig`.

## License

[MIT](https://github.com/pixel-perfect-software/provino/blob/main/LICENSE). `provino` includes code copied from Jest, Vitest and a few other projects under their own MIT licenses: see `THIRD_PARTY_NOTICES.md` in this package.
