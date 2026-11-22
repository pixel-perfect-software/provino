<p align="center">
  <img src="https://raw.githubusercontent.com/pixel-perfect-software/provino/main/assets/provino-mark.png" width="128" height="128" alt="Provino logo: a tilted test tube holding a check mark, on an indigo-to-green tile" />
</p>

<h1 align="center">provino</h1>

<p align="center">
  The Jest suite you already have, on a runner built to be faster: same config, same command line, same matchers, same snapshots.
</p>

`provino jest` runs a Jest project as it is: the same `jest.config` and Jest's flags, matchers and mocks. It writes snapshot files byte for byte as Jest does, and exits with Jest's exit codes. There's nothing to migrate: you change the command. [Why Provino →](https://github.com/pixel-perfect-software/provino/blob/main/wiki/why-provino.md)

This package is the one you install. It holds Provino's engine in one bundle, with the `provino` command. `provino jest` also needs the Jest dialect, [`@provino/dialect-jest`](https://www.npmjs.com/package/@provino/dialect-jest), installed beside it.

## 🚀 Install

A release candidate. Add it to your Jest project with its Jest dialect (with `-w` at a pnpm workspace root). It needs Node 22.15 or later, or 24.

```bash
pnpm add -D provino@rc @provino/dialect-jest@rc
```

Without the dialect, `provino jest` prints the command to install it and exits 1. A project with only a `provino.config` needs `provino` alone.

## 🧭 Getting started

```bash
pnpm exec provino jest --listTests        # the files it would run
pnpm exec provino jest path/to/a.test.ts  # one file first
pnpm exec provino jest                    # the whole suite
```

<!-- capture: a real `provino jest` run on a terminal, the final screen once the live footer is gone -->
```console
$ pnpm exec provino jest
✅ src/cart.test.ts · 3 tests · 6ms
✅ src/checkout.test.ts · 1 test · 1ms

🎉 4 tests passed in 2 files · 44ms
🐢 slowest: src/cart.test.ts 6ms · src/checkout.test.ts 1ms
snapshots: 1 passed
```

On a terminal, Provino draws its own live view while the run goes. A pipe, CI, an editor, an AI agent, `--verbose` and `--watch` get Jest's text, byte for byte. [The output, its flags and the HTML report →](https://github.com/pixel-perfect-software/provino/blob/main/wiki/output.md)

A flag Provino can't run yet is refused by name. `provino vitest` comes next. Watch mode (`--watch`, `--watchAll`) works, except that `--coverage`, `--collectTests` and `--detectOpenHandles` are refused by name with it, and coverage from saved reports (`--merge-reports`) is planned. [Jest compatibility](https://github.com/pixel-perfect-software/provino/blob/main/wiki/compatibility.md) has the full list. If a test passes under Jest and fails under Provino, please [open an issue](https://github.com/pixel-perfect-software/provino/issues).

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) @ [Pixel Perfect Software Inc.](https://github.com/pixel-perfect-software). `provino` includes code from Jest, Vitest and others, under their own MIT licenses; see `THIRD_PARTY_NOTICES.md` in this package.
