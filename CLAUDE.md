# Provino

A fast, type-safe test runner for JavaScript and TypeScript. One neutral core runs tests; Jest and Vitest are **dialects** (typed policy values plus API facades) on top of it, so Provino can drop into an existing project. RSpec-style lazy variables are the default way to define test values. Node only for v1.

Status: **pre-alpha, built in phases** from the research in `docs/research/`. Nothing is published yet.

@.claude/context/ai-context/docs-overview.md

## How work happens here

- **The plan is `docs/plan/PLAN.md`.** Tyler starts each bundle with `/project-context:full-context <bundle id>` (blank means the next unblocked one), and PLAN.md → Running a bundle is the procedure. Don't start work that isn't in the plan. If something is missing, propose an addition and ask.
- **`docs/` is a separate private repo,** `pixel-perfect-software/provino-planning`, gitignored here so the research and plans stay out of this public repo. Clone it with `git clone git@github.com:pixel-perfect-software/provino-planning.git docs`. Commit plan, decision and bundle-file changes in `docs/`, straight to its `main`; task branches and PRs are for this repo only. In a worktree, `docs/` is a symlink into the main checkout, which a worktree-isolated session can't write. Tyler's standing instruction: don't ask, leave with `ExitWorktree` (`keep`), write and commit in `docs/`, push it with `git -C docs push`, and return with `EnterWorktree` and `path`. Those git steps run in the main session; a sub-agent hands `docs/` edits back to it (Claude Code refuses `git -C <path>` from sub-agents).
- **Read narrowly.** PLAN.md → Running a bundle says exactly which sections to read. Grep for a heading and Read only that range. Never load a whole track doc, the whole build plan, or the whole PLAN.md. Use an Explore subagent for wide searches so file dumps stay out of the main context.
- **What to build** follows the precedence in `docs/plan/DECISIONS.md`: DECISIONS > build-plan §7 > §6 > §3 > §1 > track docs. **How to work** follows this file.
- **Research docs are frozen.** Never edit `docs/research/`, and never fetch the claude.ai links inside them; the repo copies are the source. New decisions go to DECISIONS.md under Proposed. Notes go in PLAN.md or `docs/plan/bundles/<id>.md`.
- **One bundle per session.** When the bundle is done, or the context is getting long, stop at a clean point and run `/project-context:handoff`. Start the next session fresh.

## Non-negotiables

1. **No runner branching in neutral packages.** `core`, `lazy`, `mock`, `timers`, `expect`, `snapshot`, `loader`, `orchestrator`, `reporters`, `coverage`, `config` and `api` (D186) never compare against `'jest'` or `'vitest'` and never import a dialect. Every Jest/Vitest difference is a typed policy key the dialect supplies. Choosing a dialect by name (the CLI's `provino jest`, config `dialect: 'jest'`, the bench's `--runner jest`) is fine.
2. **Jest/Vitest policy values need ground truth.** Every value claimed to match Jest 30.5 or Vitest 5.0 must be backed by a fixture recorded from the real runner (T1.7 in B14 builds the recorder). Until then, values copied from the research get a `// unverified: <track/table>` comment, and B14 verifies every one. Neutral-only keys we define ourselves (e.g. `isolationDefault`) need tests, not ground truth.
3. **Boundaries are law.** Imports go down the layers in `monorepo-architecture.md`, through public `exports` only, with no cycles. Core never imports the loader. Each package uses only its own policy slice. The exceptions are `policy`, `config`, the orchestrator (which ships `SerializedPolicy`) and the dialects, which handle the whole `Policy`.
4. **Anything that crosses threads is `CloneSafe`.** Behaviour crosses as a `ModuleRef`, never as a closure.
5. **Strict TypeScript.** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedDeclarations`, `erasableSyntaxOnly`. No `any` in public types. Every public API has `*.test-d.ts` type tests, including `@ts-expect-error` cases for misuse.
6. **Acceptance checks define done.** Never weaken, skip or loosen a check, golden or threshold to make it pass. The one allowed adaptation is rebuilding a spike corpus that no longer exists; follow the rule in PLAN.md → Ground rules. If a target can't be met, stop, record the measured number, and ask.
7. **Benchmarks are honest.** Label every number `local`, `desktop` or `pinned` (see `.claude/rules/benchmarks.md`). Interleave runs, report ratios against Jest, and never present a `local` number as a result.
8. **Quirk policy is DECISIONS D7.** Divergences go in `docs/plan/DIVERGENCES.md` (S5).
9. **Ask Tyler before you:** add a runtime dependency the spec doesn't name; change a Decided entry or the package map; publish anything; merge a PR (Claude opens them once the pre-merge pass is done); touch CI secrets or release config. Pushing your own `task/*` branch is allowed (S2).
10. **Fastest unless compat (D115).** Pick the fastest dependency or approach that does the job. Copy what Jest or Vitest uses only when a dialect needs that runner's exact output (dialect compat). Every plan, decision and question to Tyler says which reason applies (`speed` or `compat`) and names the faster option when compat wins; compat-only code stays off the neutral path and loads only when that dialect feature is on.

## Stack

Node 24 for dev, with CI on 22.15+, 24 and 26 · **pnpm 12.21.x** workspaces with catalogs (D9) · **Turborepo 2.11.x** for per-package tasks; `tsc -b`, Biome and type tests stay root scripts (D12) · TypeScript 7.0.2 (`tsc -b`), plus a type-test job on 5.9.3 · tsdown 0.23 (Oxc d.ts) · ESM only · **Biome** for lint and format (D11) · dependency-cruiser 18.7 · Oxc (transform, resolver, parser) · valibot and Standard Schema. Our own tests use `node:test` (S1).

Track 1 §How we start → Toolchain gives version **ranges** (checked 2026-10-30). The bundle that first installs a tool pins the exact patch version, respecting `minimumReleaseAge`. **Install tools only when their bundle needs them:** knip, publint, attw, API Extractor and changesets arrived with T1.6 (B21e, 2026-11-12): knip 6.44.1, publint 0.3.25, attw 0.18.5, API Extractor 7.60.1 (it brings its own TypeScript 6.0.3) and changesets 3.0.3, all in the catalog.

## Commands

Keep this table current: a wrong command here costs every session. Run everything from the root.

| Task                  | Command                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| Install               | `pnpm install` (CI: `pnpm install --frozen-lockfile`)                         |
| Typecheck             | `pnpm typecheck` (`tsc -b`, TS 7)                                             |
| Unit tests            | `pnpm test` (Turborepo, cached); one package: `pnpm test --filter @provino/x` |
| Type tests            | `pnpm test:types` (TS 7.0.2) and `pnpm test:types:ts5.9`                      |
| Format and lint       | `pnpm format-and-lint` (Biome lint, import order and formatting; Markdown is excluded); fix with `pnpm format-and-lint:fix` |
| Custom lint rules     | part of `pnpm format-and-lint` (Biome GritQL plugins `neutral-no-dialect-name`, `slice-discipline`; tests are exempt) |
| Build                 | `pnpm build` (Turborepo `build`, cached): every public package to `dist/` with tsdown 0.23; `provino` is one bundle. Full row: `commands.md` |
| Hygiene (T1.6, T10.4) | `pnpm hygiene [--base <ref>] [--only <section>]…` (builds first; `--base` default `origin/main`). Each check: `commands.md` |
| Pack and smoke       | `pnpm pack:all --out <dir>`; `pnpm smoke:install [--keep]`. Details: `commands.md` |
| Release (B21h, D162–D165) | A change to a public package adds a changeset (`pnpm changeset`); `pnpm changeset version` makes the "Version packages" PR; Tyler merges it and pushes the tag `v<version>`. The full steps are in `.claude/context/ai-context/commands.md`, Release section |
| Run Provino           | `pnpm provino run --config <file> [--maxWorkers n] [--pool forks\|threads\|inline] [--reporter …]`; every flag: `commands.md`, Run Provino section |
| Run a Jest project | `pnpm provino jest [jest flags and test path patterns]`; details: `commands.md`, Run Provino section |
| Boundaries            | `pnpm boundaries` (manifest check, then dependency-cruiser); after editing `tooling/boundaries/packages.json`, `pnpm boundaries:write`. A manifest node's `bannedPackages` (T7.12: `expect`, `@vitest/expect`, `jest-snapshot`, `@vitest/snapshot`, `@babel/*` for `@provino/expect` and `@provino/snapshot`) becomes a `banned-packages-*` rule: a runtime import fails, a type import and a test don't |
| Benches, corpora, goldens, harness | `pnpm bench:*`, `pnpm provino-bench …`, `pnpm provino-harness …`, `pnpm drift`: read `.claude/context/ai-context/commands.md` before running one |
| Dependency updates    | `pnpm deps:check` (report only); `pnpm deps:update` runs only when Tyler asks (autd, D14) |

- **Node below 22.18** (the 22.15 floor) needs `NODE_OPTIONS=--experimental-strip-types` for `pnpm test` and `pnpm boundaries`; CI's 22.15 leg sets it. Node 24+ strips types by default.
- **A new package** adds itself to the root `tsconfig.json` references (and `packages/<name>/test` to `tsconfig.type-tests.json`), and uses `catalog:` for shared dev tools. A public package gives every `exports` subpath three conditions in this order, `provino-source` (`./src/….ts`), `types` (`./dist/<name>.d.ts`), `import` (`./dist/<name>.js`; a types-only package like `@provino/types` has none, T1.2), lists `"files": ["dist"]` (plus `"THIRD_PARTY_NOTICES.md"` if its `dist` holds vendored code: a copy of the root file, as `LICENSE` is), has a `README.md`, and has the script `"build": "tsdown --config ../../tooling/packaging/tsdown.config.ts"`: the build reads its entries from `exports`. A package's API goes in an `etc/*.api.md` report only if D67 promises it semver (`SEMVER_PACKAGES` in `tooling/packaging/src/workspace.ts`); a private one lists itself in `.changeset/config.json`'s `ignore`.

## Git

Follow DECISIONS S2: a `task/<bundle>-<slug>` branch, small commits with `git commit -s -m "feat(<pkg>): …"`, push only your own task branch, never touch `main` directly, and never force-push.

## Library docs

Use the Context7 MCP server, when it's available, for current docs (Oxc, tsdown, Node APIs). If a pinned version has moved on since 2026-10-30, note it; don't silently upgrade.
