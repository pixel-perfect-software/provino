<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/provino-mark.png">
    <img src="assets/provino-logo.png" alt="Provino" height="80">
  </picture>
</p>

# Provino

Provino is a test runner for JavaScript and TypeScript, for Node, built to run the test suite you already have, faster. One neutral core runs the tests, and Jest and Vitest are *dialects* on top of it, so Provino can take an existing project as it is. Today the Jest dialect works: `provino jest` reads a Jest project's config and command line, and runs its tests.

## Why Provino

Most of the time a large Jest suite spends isn't spent running tests. It goes on work repeated for every test file:
- evaluating the module graph again, `node_modules` included;
- building the test environment again and re-running setup files;
- pushing source through Babel.

Jest gives each file a fresh module environment that nothing can share. That is what makes its isolation safe, and also what makes big suites slow.

The faster runners each ask you to change something first:
- **Vitest** needs Vite and has its own API (`vi`, its own config, different defaults), so moving a large Jest suite over is a migration.
- **Bun's test runner** needs the Bun runtime.
- **Node's built-in `node:test`** has no `expect`, and its module mocks are still experimental.

**Provino's goal is to be the faster runner you don't migrate to.** You point it at the Jest project you have, and the suite runs with:
- your config;
- your command line;
- your matchers;
- your snapshot files, byte for byte;
- the same exit codes.

It aims to be faster through the way it's built, without giving up isolation:

- **Your modules are fresh in every test file; `node_modules` isn't.** Each file gets a new registry for your own code, while third-party modules are evaluated once per worker and shared. A file that needs them fresh can ask for a stricter isolation tier with an `@provino-isolate` docblock.
- **Warm work is kept:**
  - workers are reused across files;
  - transformed code goes into a persistent cache;
  - Node's compile cache and V8's code cache skip recompiling.
- **Oxc compiles TypeScript and JSX instead of Babel.** Oxc is a Rust toolchain. Your project's own transformers (`babel-jest`, `ts-jest`, `@swc/jest`) still run when its config names them.
- **Matching Jest is checked, not assumed.** Every place where Jest and Vitest behave differently is a typed policy value that the dialect supplies. Each value is checked against goldens recorded from the real Jest 30.5 and Vitest 5.0, and where Provino deliberately differs, the difference is recorded.

**The bar Provino holds itself to** is its go/no-go line. On the reference suites, it must take at most half of Jest's time warm and at most 80% cold, with at least 90% of tests getting the same result as Jest. The plan has three steps after that bar:
- `provino vitest` for Vitest projects;
- RSpec-style lazy variables as the default way to define test values;
- a Rust core for discovery, resolution, transforms and scheduling.

## Status

**Pre-alpha, and not on npm.** You can install the `provino` package from a tarball you build from this repository (below), and run it against a Jest project, within the limits listed under [What's not in place yet](#whats-not-in-place-yet). Two things are not built at all: `provino vitest`, and the RSpec-style lazy variables that are planned as the default way to define test values.

There are no benchmark results to quote yet. The bar above is a target. Results will come from benchmarks on pinned hardware, which are pending; numbers from a developer's laptop are signals, not results.

## Try it on a Jest project

You need Node 22.15 or later (24 recommended) and pnpm. Installing `provino` with pnpm is the route that is tested (`pnpm smoke:install` does it from a tarball into an empty directory). Start with one project that uses only what is listed under [What works](#what-works).

### From a tarball

Build and pack Provino once:

```sh
git clone https://github.com/pixel-perfect-software/provino.git
cd provino
pnpm install
pnpm pack:all --out ~/provino-packs   # builds first, then packs every public package
```

Only `provino-0.0.0.tgz` is needed: it holds every `@provino/*` package inlined. In your Jest project:

```sh
pnpm add -D ~/provino-packs/provino-0.0.0.tgz
pnpm exec provino jest --listTests              # the test files it would run
pnpm exec provino jest path/to/one.test.ts      # one file first
pnpm exec provino jest                          # the whole suite
```

`provino jest` takes Jest's own command line, reads the Jest config found from the working directory (or `-c`/`--config`), and exits with Jest's exit codes. Provino leaves your Jest config and Jest itself alone. It writes its cache to `node_modules/.cache/provino` (under the config's `cacheDirectory`, if it sets one; `provino jest --clearCache` removes it) and, as Jest does, `.snap` files. To take it out again, run `pnpm remove provino`.

### From source

Run the source directly, with a Node that strips types (22.18 or later, or 24):

```sh
git clone https://github.com/pixel-perfect-software/provino.git
cd provino
pnpm install
alias provino="node --conditions=provino-source $PWD/packages/provino/src/cli.ts"
```

Then, from your project's root, run `provino jest --listTests` and the rest as above. Put the alias in your shell profile, with the checkout's absolute path.

To check test discovery against Jest's without running anything, run this from the checkout:

```sh
pnpm provino-bench list-tests ~/path/to/your-project
```

It compares your project's `jest --listTests --json` with Provino's, names every difference, and exits 0 when they match.

If Provino and Jest disagree on a test, please open an issue. Include the test (or a minimal copy of it), Jest's result, Provino's result, and the output of `provino jest --showConfig`.

## What works

Provino's tests compare most of what is listed here with Jest 30.5, either with recordings of the real runner or with Jest itself running beside Provino on the same project. The exception is `--showConfig`, which prints Provino's own reading of the config and is not compared with Jest's output.

**The command line and config**
- Jest's own flags and config keys, including any config key given as a flag (`--testMatch`, `--roots`, `--testTimeout`, ...), and Jest's exit codes. A flag Provino can't run yet is refused by name, with the task that builds it, and never ignored without saying so.
- A config with several `projects`, run in one pool. `--selectProjects` and `--ignoreProjects` work.
- Test path patterns and `--runTestsByPath`, `-t`, `-u`/`--updateSnapshot`, `-w`/`-i`, `--ci`, `--passWithNoTests`, `--no-cache`, `--listTests [--json]`, `--showConfig` and `--clearCache`.
- `--bail`, `--forceExit`, `--detectOpenHandles`, `workerIdleMemoryLimit`, and `--shard=i/n` (Jest's split, or cut by time from a timings file with Provino's own `--timings` and `--update-timings`).
- Ctrl+C stops the run and exits 130, and a second Ctrl+C kills every worker at once. SIGTERM exits 143.
- `globalSetup` and `globalTeardown`, run once per project and path as Jest runs them.

**Your code**
- TypeScript, TSX, JSX and JavaScript, compiled with Oxc: types are stripped, not checked.
- The project's own transformers (`babel-jest` when the project has a Babel config, `ts-jest`, `@swc/jest`, ...), as Jest runs them.
- `moduleNameMapper`, `moduleDirectories`, `modulePaths` and a custom `resolver`.
- The `node` test environment, and `jsdom` or a custom environment through the project's own environment class (for `jsdom`, the project's `jest-environment-jsdom`, which must be installed, as with Jest). The `@jest-environment` docblock works.

**Your tests**
- Jest's globals: `describe`, `test`/`it`, the four hooks, `.only`/`.skip`, `.each` (with Jest's titles), `done` callbacks, and `import ... from '@jest/globals'`.
- `expect` with Jest's matchers (copied from Jest), asymmetric matchers and `expect.extend`.
- Mock functions, spies, `jest.mock` (hoisted, with a factory, automock or a `__mocks__` file), `clearMocks`, `resetMocks` and `restoreMocks`.
- Modern fake timers (`jest.useFakeTimers()` and the `fakeTimers` config key).
- `toMatchSnapshot`, writing `.snap` files that are checked byte for byte against recordings of Jest 30.5.2 (the `-u` and `--ci` cases, obsolete snapshots included).
- Retries with `jest.retryTimes(n, options)`.

**Output**
- The `default` and `verbose` reporters print Jest's text (checked line by line against recordings of Jest, apart from the lines named in the table below), and `--verbose`, `--silent`, `--expand`, `--noStackTrace` and `--colors`/`--no-color` apply.
- Under an AI agent (`CLAUDECODE`, `AI_AGENT`, ...) the `agent` reporter is chosen (failures and totals), and on GitHub Actions `github-actions` is added.
- The `dot`, `json` and `junit` reporters exist, but `provino jest` can't choose them (`--reporters` and `--json` are refused). They are chosen with `provino run --config <file> --reporter <name>`, Provino's own config form.

## What's not in place yet

This is the list of gaps the code names; another one you hit is a bug worth an issue. Provino warns about the config keys it reads and can't apply (`collectCoverage`, `reporters`, `snapshotResolver`). A task number names the work in Provino's build plan, which is not public.

| Gap | What happens today | Task |
| --- | --- | --- |
| Coverage: `--coverage`, `--collectCoverage` | The flags are refused (exit 1). `collectCoverage: true` in the config warns, and the run goes ahead without coverage | T8.8 |
| Watch mode: `--watch`, `--watchAll` | Refused | T9.11 |
| `--json`, `--outputFile`, `--collectTests` for a run | Refused. `--listTests --json` works | T11.8 |
| Custom reporters: `--reporters`, the `reporters` config key | The flag is refused. The key warns, and the default reporter runs | T11.9 |
| Run only what changed: `--onlyChanged`, `--changedSince`, `--lastCommit`, `--changedFilesWithAncestor`, `--findRelatedTests`, `--onlyFailures` | Refused | no task yet |
| Random order: `--randomize`, `--seed`, `--showSeed` | Refused | no task yet |
| `--detectLeaks` | Refused | T2.7 |
| `--filter`, and the `--projects` flag | Refused. A `projects` key in the config does run | no task yet |
| `--debug`, `--logHeapUsage`, `--notify`, `--notifyMode` | Warn, and are otherwise ignored | T9.7 |
| `snapshotResolver` | Warns. Snapshots stay beside the test file | a later bundle |
| Inline snapshots (`toMatchInlineSnapshot`) | A match passes and a mismatch fails, but one that would need to be written (a new one, or `-u`) fails, naming T7.11 | T7.11 |
| Legacy fake timers | `legacyFakeTimers: true` throws when a test installs the timers, with a hint to use the modern ones. `jest.runAllImmediates` throws | not planned for v1 |
| `jest.retryTimes(n, { entireDescribe })` | Throws | T5.10 |
| `-i`/`--runInBand` | Still starts a worker, so a test doesn't see a global that `globalSetup` set, as it does in Jest | T9.9 |
| A custom environment's `handleTestEvent` | Not called | T8 or T11, no number yet |
| Jest's `Ran all test suites.` line and snapshot summary block | Not printed | no task yet |
| `provino vitest` | Refused | T11.16 |
| RSpec-style lazy variables | Not built | T6.2 and after |

## How it works

One neutral core runs the tests. It never asks which runner it is imitating: every place where Jest and Vitest behave differently is a typed *policy* value that a dialect supplies, and the API each one exposes (`jest` or `vi`, `expect`, the globals) is its own facade. A dialect is a value made of policy values, a config reader, a command-line parser and those facades, and `provino jest` is the Jest dialect plus the neutral core.

A coordinator discovers and orders the test files, and a pool of workers (child processes, worker threads or the coordinator's own process) runs them, each file with a fresh module registry by default and its own test environment. Behaviour crosses between the two as a reference to a module, never as a function.

The values Provino claims match Jest 30.5 or Vitest 5.0 are checked against fixtures recorded from the real runners (`pnpm test --filter @provino/harness` runs the checks); a few are still pending a recording. The tests also run real Jest beside Provino on the same projects and compare the result of each test.

## Development

A pnpm workspace (pnpm 12) on Node 24, with Turborepo, TypeScript 7 and Biome. Provino's own tests use `node:test`.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:types
pnpm lint
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rest: the commands, the conventions, and how to commit.

## License

[MIT](LICENSE). Provino includes code copied from Jest, Vitest and a few other projects, under their own MIT licenses: see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
