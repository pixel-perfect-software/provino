<p align="center">
  <img src="https://raw.githubusercontent.com/pixel-perfect-software/provino/main/assets/provino-mark.png" width="128" height="128" alt="Provino logo: a tilted test tube holding a check mark, on an indigo-to-green tile" />
</p>

<h1 align="center">provino</h1>

<p align="center">
  The Jest suite you already have, on a runner built to be faster: same config, same command line, same matchers, same snapshots.
</p>

`provino jest` runs a Jest project as it is: the same `jest.config` and Jest's flags, matchers and mocks. It writes snapshot files byte for byte as Jest does, and exits with Jest's exit codes. There's nothing to migrate: you change the command. [Why Provino →](https://github.com/pixel-perfect-software/provino/blob/main/wiki/why-provino.md)

This package is the one you install. It holds every `@provino/*` package in one bundle, with the `provino` command.

## 🚀 Install

**Pre-alpha, and not published yet.** Until the first release, build the package from [the repository](https://github.com/pixel-perfect-software/provino), then add it to your Jest project. It needs Node 22.15 or later, or 24.

```bash
git clone https://github.com/pixel-perfect-software/provino.git && cd provino
pnpm install && pnpm pack:all --out ~/provino-packs

cd ~/your-project
pnpm add -D ~/provino-packs/provino-0.0.0.tgz
```

## 🧭 Getting started

```bash
pnpm exec provino jest --listTests        # the files it would run
pnpm exec provino jest path/to/a.test.ts  # one file first
pnpm exec provino jest                    # the whole suite
```

A flag Provino can't run yet is refused by name. Coverage, watch mode, `--json` output and custom reporters are planned; [Jest compatibility](https://github.com/pixel-perfect-software/provino/blob/main/wiki/compatibility.md) has the full list. If a test passes under Jest and fails under Provino, please [open an issue](https://github.com/pixel-perfect-software/provino/issues).

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) @ [Pixel Perfect Software Inc.](https://github.com/pixel-perfect-software). `provino` includes code from Jest, Vitest and others, under their own MIT licenses; see `THIRD_PARTY_NOTICES.md` in this package.
