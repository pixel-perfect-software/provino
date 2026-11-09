# Provino

A fast, type-safe test runner for JavaScript and TypeScript, built to drop into an existing Jest or Vitest project.

> **Status: pre-alpha.** Nothing is published to npm yet. You can run it from a checkout against a Jest project today, within the limits below.

## How it works

One neutral core runs the tests. Jest and Vitest are *dialects* on top of it: a typed policy value for every place the two runners behave differently, plus the API each one exposes (`jest` or `vi`, `expect`, the globals). That lets Provino take your Jest config and command line as they are. The values it claims to match are checked against goldens recorded from the real Jest 30.5 and Vitest 5.0.

RSpec-style lazy test variables are planned as the default way to define test values. They aren't built yet.

Node only: 22.15+ or 24+.

## Try it on a Jest project

Provino runs from source, so you need pnpm and a Node that strips types (22.18+, or 24+).

```sh
git clone https://github.com/pixel-perfect-software/provino.git
cd provino
pnpm install
alias provino="node --conditions=provino-source $PWD/packages/provino/src/cli.ts"
```

Put the alias in your shell profile with the absolute path. Then, from your project's root:

```sh
provino jest --showConfig        # the config as Provino resolved it
provino jest --listTests         # the test files it would run
provino jest path/to/one.test.ts # one file first
provino jest                     # the whole suite
```

`provino jest` takes Jest's own command line, reads the Jest config found from the working directory (or `-c`/`--config`), and exits with Jest's exit codes.

To check discovery against Jest's without running any tests, run this from the Provino checkout:

```sh
pnpm provino-bench list-tests ~/path/to/your-project
```

It compares your project's `jest --listTests --json` with Provino's and names every difference. Exit 0 means they match.

**A good first project** uses the `node` test environment, has one Jest project, and doesn't depend on `moduleNameMapper` or a Babel plugin.

### What works

- Test files in TypeScript, TSX/JSX or JavaScript. Provino compiles them itself with Oxc.
- The `node` test environment.
- Jest's globals: `describe`, `test`/`it`, hooks, `.only`/`.skip`, `.each` (with Jest's titles) and `done` callbacks.
- `expect` with Jest's matchers.
- Mock functions, spies and `jest.mock` (hoisted, with factories or automock), plus `clearMocks`, `resetMocks` and `restoreMocks`.
- Modern fake timers (`jest.useFakeTimers()`).
- `toMatchSnapshot`, writing `.snap` files byte-identical to Jest's; `-u` updates them.
- These flags: test path patterns and `--runTestsByPath`, `-t`, `-u`/`--updateSnapshot`, `-w`/`-i`, `--ci`, `--passWithNoTests`, `--no-cache`, `--listTests [--json]`, `--showConfig`, `--clearCache`, and any config key as a flag (`--testMatch`, `--roots`, `--testTimeout`, …).

### Not yet

These config keys print a warning and the run goes ahead without them:

- `transform`: custom transformers (`babel-jest`, `ts-jest`, `@swc/jest`) don't run. TypeScript and JSX still compile, but Babel plugins your tests rely on don't apply.
- `moduleNameMapper`: path aliases and asset stubs aren't applied, so imports that need them fail.
- `testEnvironment` other than `node` (`jsdom`, `happy-dom`, custom environments).
- `fakeTimers.enableGlobally`.

Other gaps:

- These flags are refused by name, with exit code 1: `--watch`, `--coverage`, `--bail`, `--shard`, `--forceExit`, `--reporters`, `--json` for a run, `--onlyChanged`, `--findRelatedTests` and `--projects`.
- Presentation flags (`--verbose`, `--silent`, `--colors`, …) warn that they aren't applied.
- A config with several `projects` lists them but doesn't run them.
- `import { jest } from '@jest/globals'` isn't bound to Provino's `jest` yet. Use the global `jest`.
- Legacy fake timers aren't supported.
- `provino vitest` isn't available yet.

If Provino and Jest disagree on a test, please open an issue. Include the test (or a minimal copy of it), Jest's result, Provino's result, and the output of `provino jest --showConfig`.

## Development

A pnpm workspace with Turborepo, TypeScript 7 and Biome. Provino's own tests use `node:test`.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:types
pnpm lint
```

The full command list is in [`CLAUDE.md`](CLAUDE.md) → Commands.

## License

[MIT](LICENSE)
