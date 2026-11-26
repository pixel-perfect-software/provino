<p align="center">
  <img src="assets/provino-mark.svg" width="128" height="128" alt="Provino logo: a tilted test tube holding a check mark, on an indigo-to-green tile" />
</p>

<h1 align="center">Provino</h1>

<p align="center">
  The Jest suite you already have, on a runner built to be faster: same config, same command line, same matchers, same snapshots.
</p>

<p align="center">
  <a href="https://github.com/pixel-perfect-software/provino/actions/workflows/ci.yml"><img src="https://github.com/pixel-perfect-software/provino/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/provino"><img src="https://img.shields.io/npm/v/provino/rc?label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/node-22.15%2B%20%7C%2024%2B-339933" alt="Node.js 22.15 or later, or 24 or later" />
  <img src="https://img.shields.io/badge/runs-Jest%2030%20projects-C21325" alt="Runs Jest 30 projects" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
</p>

`provino jest` runs a Jest project as it is: the same `jest.config` and Jest's flags, matchers and mocks. It writes snapshot files byte for byte as Jest does, and exits with Jest's exit codes. There's nothing to migrate: you change the command. Underneath, it's built not to redo work for every test file. [Why Provino →](wiki/why-provino.md)

<!-- capture: a real `provino jest` run on a terminal, the final screen once the live footer is gone -->
```console
$ pnpm exec provino jest
✅ src/cart.test.ts · 3 tests · 6ms
✅ src/checkout.test.ts · 1 test · 1ms

🎉 4 tests passed in 2 files · 44ms
🐢 slowest: src/cart.test.ts 6ms · src/checkout.test.ts 1ms
snapshots: 1 passed
```

On a terminal, Provino draws its own live view while the run goes. A pipe, CI, an editor, an AI agent, `--verbose` and `--watch` get Jest's text, byte for byte. [The output, its flags and the HTML report →](wiki/output.md)

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
- ✏️ **Your editor,** vscode-jest and neotest-jest, with `provino jest` as the Jest command.
- 🌱 **Provino-native projects.** A `provino.config.ts` and `import { describe, it, expect, fn } from 'provino'`: Provino's own matchers, mocks and timers, with nothing from Jest or Vitest installed or loaded. [Provino-native projects →](wiki/native.md)
- 🦥 **Lazy variables,** RSpec style: `import { lazy } from 'provino'` for values that are built on first read, memoized per test and overridden in a nested `describe`. [Lazy variables →](wiki/lazy-variables.md)
- 📊 **Coverage** with `--coverage`: Istanbul or V8, Jest's reports and thresholds.
- 🧵 **Sharding that balances:** Jest's split, or by recorded time.
- 🤖 **Output for people, CI and agents:** Provino's own live view in a terminal (`--tree` and `--map` add a folder tree and a status map), Jest's text byte for byte wherever a machine reads it, annotations on GitHub Actions, and a compact report under an AI agent, and a single-file HTML report.

## 📋 Requirements

- **Node.js** 22.15 or later, or 24 or later (24 recommended).
- **A Jest project,** to use `provino jest`. Provino matches Jest 30.5's behaviour.

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

Provino is a release candidate. Add it to your Jest project with its Jest dialect (with `-w` at a pnpm workspace root):

```bash
pnpm add -D provino@rc @provino/dialect-jest@rc
```

A project that uses only `provino.config` and `import … from 'provino'` needs `provino` alone, and installs nothing from Jest.

## 🧭 Getting started

With a Jest project:

```bash
pnpm exec provino jest --listTests        # the files it would run
pnpm exec provino jest src/cart.test.ts   # one file first
pnpm exec provino jest                    # the whole suite
```

With no Jest at all, add a `provino.config.ts` and a test that imports from `provino`. A `.ts` config needs Node 22.18 or later; on 22.15 to 22.17 use `provino.config.mjs` ([why](wiki/native.md#the-config)).

```ts
import { defineConfig } from 'provino/config'

export default defineConfig({ include: ['src/**/*.test.ts'] })
```

```ts
import { expect, fn, it } from 'provino'

it('records a call', () => {
  const f = fn()
  f('a')
  expect(f.mock.calls).toEqual([['a']])
})
```

```bash
pnpm exec provino
```

## ⌨️ Commands

| Command                              | Description                                                         |
| ------------------------------------ | ------------------------------------------------------------------- |
| `provino jest [flags] [patterns]`    | Run a Jest project, with Jest's command line and exit codes          |
| `provino jest --listTests`           | List the test files without running them                             |
| `provino jest --showConfig`          | Print the config as Provino resolved it                              |
| `provino jest --clearCache`          | Remove Provino's cache                                               |
| `provino jest --shard=i/n`           | Run one shard; add `--timings <file>` to cut by recorded time        |
| `provino jest --watch`               | Rerun the tests a change reaches; `--watchAll` reruns them all       |
| `provino jest -o`                    | Run only the tests for files changed since the last commit           |
| `provino` or `provino run`           | Run a native project from its `provino.config.*`                     |
| `provino run --watch`                | Rerun the tests a change reaches                                     |
| `provino --help`                     | Every command and option                                             |

## 🚧 Not in place yet

`provino vitest` comes next. Watch mode (`--watch`, `--watchAll`) works, except that `--coverage`, `--collectTests` and `--detectOpenHandles` are refused by name with it, and coverage from saved reports (`--merge-reports`) is planned. [Jest compatibility](wiki/compatibility.md) has the full list. If a test passes under Jest and fails under Provino, that's a bug: please [open an issue](https://github.com/pixel-perfect-software/provino/issues).

## 📚 Learn more

- [Why Provino](wiki/why-provino.md): the problem, the goal, and the go/no-go bar.
- [Jest compatibility](wiki/compatibility.md): what works, and every gap.
- [Provino-native projects](wiki/native.md): no Jest, one import, Provino's own policy.
- [Output](wiki/output.md): the terminal view, its flags, and the HTML report.
- [Lazy variables](wiki/lazy-variables.md): `lazy`, scopes, shared examples.
- [How it works](wiki/how-it-works.md)
- [Troubleshooting](wiki/troubleshooting.md)

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## 💸 Support this project

<a href="https://www.buymeacoffee.com/tylernrobertson" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" height="50" width="217" /></a>

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) @ [Pixel Perfect Software Inc.](https://github.com/pixel-perfect-software). See [LICENSE](LICENSE) for details, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the code Provino includes from Jest, Vitest and others.
