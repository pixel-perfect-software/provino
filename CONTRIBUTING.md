# Contributing to Provino

Thanks for helping. Provino is pre-alpha: the README says what works and what doesn't, and an issue that shows Provino and Jest disagreeing on a real test is the most useful thing you can send.

## Set up

- **Node 24** for development. CI also runs 22.15 (the floor) and 26. `.tool-versions` names the exact versions for asdf or mise.
- **pnpm 12 only.** Don't use npm, npx or yarn, in commands, scripts or docs. The version is pinned in the root `package.json` (`packageManager`).

```sh
git clone https://github.com/pixel-perfect-software/provino.git
cd provino
pnpm install
```

On Node below 22.18, set `NODE_OPTIONS=--experimental-strip-types` for `pnpm test` and `pnpm boundaries`. Node 24 strips types by default.

## Commands

Run everything from the repository root.

| Task | Command |
| --- | --- |
| Typecheck | `pnpm typecheck` |
| Unit tests | `pnpm test` (one package: `pnpm test --filter @provino/core`) |
| Type tests | `pnpm test:types` and `pnpm test:types:ts5.9` |
| Lint, and fix | `pnpm lint`, `pnpm lint --write` |
| Format, and check | `pnpm format`, `pnpm format:check` (Markdown is not formatted) |
| Package boundaries | `pnpm boundaries` |
| Build | `pnpm build` |
| Package checks | `pnpm hygiene`: builds, packs every public package and checks the tarballs, the API reports and the changesets |
| Try it on a Jest project | see the README; `pnpm smoke:install` installs the packed `provino` into an empty directory and runs it |

The full command list, with every bench and corpus command, is in the Commands table of [`CLAUDE.md`](CLAUDE.md). That file is written for coding agents, but its table is current.

## Conventions

- **TypeScript only.** Packages, scripts and tests are TypeScript, and scripts run on Node's type stripping. The only committed `.js` files are in `fixtures/` directories: projects the harness records real Jest and Vitest against. Tests that need another JavaScript project generate it into a temp directory as text.
- **Strict TypeScript:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedDeclarations` and `erasableSyntaxOnly` (no `enum`, `namespace` or parameter properties). No `any` in public types. Relative imports use the `.ts` extension.
- **Biome** formats and lints. `pnpm lint --write` fixes what it can, and `pnpm format` formats.
- **Tests use `node:test`** with `node:assert/strict`, in `*.test.ts` files next to the source. Every public API also has type tests (`*.test-d.ts`, with `expect-type`), including a `@ts-expect-error` line for each misuse, and they must pass on TypeScript 7 and 5.9. Don't wait on real time in a unit test: use a fake clock or an explicit signal.
- **Boundaries.** Packages import only downward through the layers in [`monorepo-architecture.md`](.claude/context/ai-context/monorepo-architecture.md), by their public `exports`, and `pnpm boundaries` fails on a violation. The neutral packages (`core`, `mock`, `timers`, `expect`, `snapshot`, `loader`, `orchestrator`, `reporters`, `config`) never compare against `'jest'` or `'vitest'` and never import a dialect: a difference between the two runners is a typed policy value that a dialect supplies.
- **Public API.** Every export of a published package is tagged `@public`, `@beta` or `@internal`. For the packages with a semver promise before 1.0 (`provino`, the two dialects, the two environments and `@provino/types`), a change to a `@public` signature needs a changeset: run `pnpm changeset`. `pnpm hygiene` checks it.
- **Dependencies** are exact pins in the catalog of `pnpm-workspace.yaml`, and a version must be at least seven days old. Open an issue before adding a runtime dependency. Packages must not have install scripts.

## Goldens come from the real runners

Where Provino claims to match Jest or Vitest, a fixture recorded from the real runner is the evidence. Record fixtures with the harness (`pnpm provino-harness record <fixture dir>`, and `--check` to fail on drift), and don't write or edit one by hand. If Provino and a golden disagree, either Provino is wrong or the difference is deliberate. Never change a golden, a threshold or a check to make a failure go away: fix Provino, or open an issue about the difference.

Code copied from Jest or Vitest goes in a `vendor` directory with an `UPSTREAM.md` (source, version, and every local patch) and its license in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The packages that ship copied code carry a copy of that file, and `pnpm hygiene` fails when one is missing or out of date.

Benchmark numbers from a laptop are a development signal, never a result. Label each one `local`, `desktop` or `pinned`, as [`.claude/rules/benchmarks.md`](.claude/rules/benchmarks.md) describes.

## Commits and pull requests

- Branch from `main`, and make small commits.
- **Sign off every commit** (`git commit -s`), which adds a `Signed-off-by` line, as the [Developer Certificate of Origin](https://developercertificate.org/) describes.
- **Start the subject with a conventional prefix**, with the package in parentheses when one package changes: `feat(loader): ...`, `fix(snapshot): ...`, `docs: ...`, `test(core): ...`, `refactor(...)`, `build(packaging): ...`, `chore: ...`. Say what the change does, and why in the body.
- Before you open a pull request, run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm test:types` and `pnpm boundaries`, and `pnpm hygiene` if you touched a package's exports, metadata or build.
- In the pull request, say what changed and how you checked it. Say what you did not verify.

By contributing you agree that your work is licensed under the [MIT license](LICENSE).
