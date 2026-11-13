<p align="center">
  <img src="assets/provino-mark.svg" width="128" height="128" alt="Provino logo: a tilted test tube holding a check mark, on an indigo-to-green tile" />
</p>

<h1 align="center">Provino</h1>

<p align="center">
  The Jest suite you already have, on a runner built to be faster: same config, same command line, same matchers, same snapshots.
</p>

<p align="center">
  <a href="https://github.com/pixel-perfect-software/provino/actions/workflows/ci.yml"><img src="https://github.com/pixel-perfect-software/provino/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <img src="https://img.shields.io/badge/status-pre--alpha-F59E0B" alt="Status: pre-alpha" />
  <img src="https://img.shields.io/badge/node-22.15%2B%20%7C%2024%2B-339933" alt="Node.js 22.15 or later, or 24 or later" />
  <img src="https://img.shields.io/badge/runs-Jest%2030%20projects-C21325" alt="Runs Jest 30 projects" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
</p>

`provino jest` runs a Jest project as it is: the same `jest.config` and Jest's flags, matchers and mocks. It writes snapshot files byte for byte as Jest does, and exits with Jest's exit codes. There's nothing to migrate: you change the command. Underneath, it's built not to redo work for every test file. [Why Provino →](wiki/why-provino.md)

```console
$ pnpm exec provino jest --verbose
PASS src/cart.test.ts
  cart
    ✓ adds up the items (4 ms)
    ✓ applies a coupon
    ✓ renders a receipt (2 ms)

PASS src/checkout.test.ts
  ✓ charges the total once (2 ms)

Test Suites: 2 passed, 2 total
Tests:       4 passed, 4 total
Snapshots:   1 passed, 1 total
Time:        1.412 s
```

| Your project has                                   | Under `provino jest`                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `jest.config.ts` (or `.js`, `.json`, a `jest` key) | Read and validated as Jest reads it, presets and `projects` included    |
| `jest --ci -t "checkout"`                          | `provino jest --ci -t "checkout"`                                       |
| `expect`, `jest.fn`, `jest.mock`                   | Jest's matchers and mock semantics, hoisting included                   |
| `__snapshots__/*.snap`                             | Read and written byte for byte as Jest writes them                      |
| `babel-jest`, `ts-jest`, `@swc/jest`               | Run as Jest runs them; with none, Oxc compiles TypeScript and JSX       |

## ✨ Features

- 🔁 **A drop-in command.** Jest's command line and config, as they are. A flag Provino can't run yet is refused by name, never silently ignored.
- 🧪 **Checked against the real Jest.** Behaviour is checked against goldens recorded from Jest 30.5, and against real Jest running beside it.
- 📸 **Snapshots byte for byte,** with `-u`, `--ci` and obsolete snapshots handled as Jest handles them.
- 🧩 **Your setup, as it is:** `projects`, `moduleNameMapper`, your transformers, `jsdom` and custom environments, and `globalSetup`.
- 🦥 **Lazy variables,** RSpec style: `import { lazy } from 'provino'` for values that are built on first read, memoized per test and overridden in a nested `describe`. [Lazy variables →](wiki/lazy-variables.md)
- 🧵 **Sharding that balances:** Jest's split, or by recorded time.
- 🤖 **Output for people, CI and agents:** Jest's text in a terminal, annotations on GitHub Actions, and a compact report under an AI agent.

## 📋 Requirements

- **Node.js** 22.15 or later, or 24 or later (24 recommended).
- **A Jest project.** Provino matches Jest 30.5's behaviour.
- **pnpm,** to build the package until it's published.

```ts
import { lazy } from 'provino'

const $ = lazy.let('user', () => ({ name: 'Ada' })).let('greeting', ({ user }) => `hello ${user.name}`)

describe('greeting', () => {
  it('reads what it needs', () => expect($.greeting).toBe('hello Ada'))

  describe('for Grace', () => {
    $.override('user', () => ({ name: 'Grace' }))
    it('sees the override', () => expect($.greeting).toBe('hello Grace'))
  })
})
```

## 🚀 Install

Provino is pre-alpha and not on npm yet. Build the package from this repository, then add it to your project (with `-w` at a pnpm workspace root):

```bash
git clone https://github.com/pixel-perfect-software/provino.git && cd provino
pnpm install && pnpm pack:all --out ~/provino-packs

cd ~/your-project
pnpm add -D ~/provino-packs/provino-0.0.0.tgz
```

## 🧭 Getting started

```bash
pnpm exec provino jest --listTests        # the files it would run
pnpm exec provino jest src/cart.test.ts   # one file first
pnpm exec provino jest                    # the whole suite
```

## ⌨️ Commands

| Command                              | Description                                                         |
| ------------------------------------ | ------------------------------------------------------------------- |
| `provino jest [flags] [patterns]`    | Run a Jest project, with Jest's command line and exit codes          |
| `provino jest --listTests`           | List the test files without running them                             |
| `provino jest --showConfig`          | Print the config as Provino resolved it                              |
| `provino jest --clearCache`          | Remove Provino's cache                                               |
| `provino jest --shard=i/n`           | Run one shard; add `--timings <file>` to cut by recorded time        |
| `provino --help`                     | Every command and option                                             |

## 🚧 Not in place yet

Coverage, watch mode, `--json` output and custom reporters are planned, and are refused by name until then. `provino vitest` comes next. [Jest compatibility](wiki/compatibility.md) has the full list. If a test passes under Jest and fails under Provino, that's a bug: please [open an issue](https://github.com/pixel-perfect-software/provino/issues).

## 📚 Learn more

- [Why Provino](wiki/why-provino.md): the problem, the goal, and the go/no-go bar.
- [Jest compatibility](wiki/compatibility.md): what works, and every gap.
- [Lazy variables](wiki/lazy-variables.md): `lazy`, scopes, shared examples.
- [How it works](wiki/how-it-works.md)
- [Troubleshooting](wiki/troubleshooting.md)

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## 💸 Support this project

<a href="https://www.buymeacoffee.com/tylernrobertson" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" height="50" width="217" /></a>

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) @ [Pixel Perfect Software Inc.](https://github.com/pixel-perfect-software). See [LICENSE](LICENSE) for details, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the code Provino includes from Jest, Vitest and others.
