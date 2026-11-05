# Provino

A fast, type-safe test runner for JavaScript and TypeScript. One neutral core runs tests; Jest and Vitest are **dialects** (typed policy values plus API facades) on top of it, so Provino can drop into an existing project. RSpec-style lazy variables are the default way to define test values. Node only for v1.

Status: **pre-alpha, built in phases** from the research in `docs/research/`. Nothing is published yet.

@.claude/context/ai-context/docs-overview.md

## How work happens here

- **The plan is `docs/plan/PLAN.md`.** Tyler starts each bundle with `/project-context:full-context <bundle id>` (blank means the next unblocked one), and PLAN.md → Running a bundle is the procedure. Don't start work that isn't in the plan. If something is missing, propose an addition and ask.
- **`docs/` is a separate private repo,** `pixel-perfect-software/provino-planning`, gitignored here so the research and plans stay out of this public repo. Clone it with `git clone git@github.com:pixel-perfect-software/provino-planning.git docs`. Commit plan, decision and bundle-file changes in `docs/`, straight to its `main`; task branches and PRs are for this repo only.
- **Read narrowly.** PLAN.md → Running a bundle says exactly which sections to read. Grep for a heading and Read only that range. Never load a whole track doc, the whole build plan, or the whole PLAN.md. Use an Explore subagent for wide searches so file dumps stay out of the main context.
- **What to build** follows the precedence in `docs/plan/DECISIONS.md`: DECISIONS > build-plan §7 > §6 > §3 > §1 > track docs. **How to work** follows this file.
- **Research docs are frozen.** Never edit `docs/research/`, and never fetch the claude.ai links inside them; the repo copies are the source. New decisions go to DECISIONS.md under Proposed. Notes go in PLAN.md or `docs/plan/bundles/<id>.md`.
- **One bundle per session.** When the bundle is done, or the context is getting long, stop at a clean point and run `/project-context:handoff`. Start the next session fresh.

## Non-negotiables

1. **No runner branching in neutral packages.** `core`, `lazy`, `mock`, `timers`, `expect`, `snapshot`, `loader`, `orchestrator`, `reporters` and `config` never compare against `'jest'` or `'vitest'` and never import a dialect. Every Jest/Vitest difference is a typed policy key the dialect supplies. Choosing a dialect by name (the CLI's `provino jest`, config `dialect: 'jest'`, the bench's `--runner jest`) is fine.
2. **Jest/Vitest policy values need ground truth.** Every value claimed to match Jest 30.5 or Vitest 5.0 must be backed by a fixture recorded from the real runner (T1.7 in B14 builds the recorder). Until then, values copied from the research get a `// unverified: <track/table>` comment, and B14 verifies every one. Neutral-only keys we define ourselves (e.g. `isolationDefault`) need tests, not ground truth.
3. **Boundaries are law.** Imports go down the layers in `monorepo-architecture.md`, through public `exports` only, with no cycles. Core never imports the loader. Each package uses only its own policy slice. The exceptions are `policy`, `config`, the orchestrator (which ships `SerializedPolicy`) and the dialects, which handle the whole `Policy`.
4. **Anything that crosses threads is `CloneSafe`.** Behaviour crosses as a `ModuleRef`, never as a closure.
5. **Strict TypeScript.** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedDeclarations`, `erasableSyntaxOnly`. No `any` in public types. Every public API has `*.test-d.ts` type tests, including `@ts-expect-error` cases for misuse.
6. **Acceptance checks define done.** Never weaken, skip or loosen a check, golden or threshold to make it pass. The one allowed adaptation is rebuilding a spike corpus that no longer exists; follow the rule in PLAN.md → Ground rules. If a target can't be met, stop, record the measured number, and ask.
7. **Benchmarks are honest.** Label every number `local`, `desktop` or `pinned` (see `.claude/rules/benchmarks.md`). Interleave runs, report ratios against Jest, and never present a `local` number as a result.
8. **Quirk policy is DECISIONS D7.** Divergences go in `docs/plan/DIVERGENCES.md` (S5).
9. **Ask Tyler before you:** add a runtime dependency the spec doesn't name; change a Decided entry or the package map; publish anything; open or merge a PR; touch CI secrets or release config. Pushing your own `task/*` branch is allowed (S2).

## Stack

Node 24 for dev, with CI on 22.15+, 24 and 26 · **pnpm 12.16.x** workspaces with catalogs (D9) · **Turborepo 2.11.x** for per-package tasks; `tsc -b`, Biome and type tests stay root scripts (D12) · TypeScript 7.0.2 (`tsc -b`), plus a type-test job on 5.9.3 · tsdown 0.23 (Oxc d.ts) · ESM only · **Biome** for lint and format (D11) · dependency-cruiser 18.7 · Oxc (transform, resolver, parser) · valibot and Standard Schema. Our own tests use `node:test` (S1).

Track 1 §How we start → Toolchain gives version **ranges** (checked 2026-10-30). The bundle that first installs a tool pins the exact patch version, respecting `minimumReleaseAge`. **Install tools only when their bundle needs them:** knip, publint, attw, API Extractor and changesets arrive with T1.6, not in B01.

## Commands

Keep this table current: a wrong command here costs every session. Run everything from the root.

| Task                  | Command                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| Install               | `pnpm install` (CI: `pnpm install --frozen-lockfile`)                         |
| Typecheck             | `pnpm typecheck` (`tsc -b`, TS 7)                                             |
| Unit tests            | `pnpm test` (Turborepo, cached); one package: `pnpm test --filter @provino/x` |
| Type tests            | `pnpm test:types` (TS 7.0.2) and `pnpm test:types:ts5.9`                      |
| Lint                  | `pnpm lint` (Biome rules + import order); fix with `pnpm lint --write`        |
| Format / format check | `pnpm format` / `pnpm format:check` (Biome; Markdown is excluded)             |
| Custom lint rules     | part of `pnpm lint` (Biome GritQL plugins `neutral-no-dialect-name`, `slice-discipline`; tests are exempt) |
| Boundaries            | `pnpm boundaries` (manifest check, then dependency-cruiser); after editing `tooling/boundaries/packages.json`, `pnpm boundaries:write` |
| Run Provino           | `pnpm provino run --config <file> [--maxWorkers n] [--pool forks\|threads\|inline] [--reporter default\|normalized-json]… [--outputFile path] [-t pattern] [--ci] [--passWithNoTests] [--no-cache]` (temporary bin, B11; T11.13 adds `provino jest`); exit 0 pass, 1 test failure, 2 usage or config error |
| Bench suites          | `pnpm provino-bench check <suite> --runner jest --runner vitest` (suites: `app-N`, `mock-heavy-N`, `isolate-heavy`); add `--runner provino` to run the `provino` bin on the suite's `jest/` tree at the default `maxWorkers` (every test passes, its normalized-json parses, and with `--runner jest` too each test's status equals Jest's: B11's acceptance is `pnpm provino-bench check app-500 --runner jest --runner provino`); `pnpm provino-bench run --runner jest <suite>` writes a `local` BenchRecord to `packages/bench/.results/` (`run` takes `provino` too, recorded as `provino:jest` at isolation `registry`, with its results cache kept)|
| Kill-check            | `pnpm provino-bench kill-check [--label local\|desktop\|pinned] [--dry-run] [--out <file>] [--machine-id <id>] [--timeout <min>]` (Track 12 R6, T12.15, provisional): Provino against Jest, warm and cold, plus registry/none on app-500, with the fixed 10 warm and 5 cold runs and the parity read; suites that can't run yet print PENDING; the verdict is PROVISIONAL unless the label is `pinned` and every suite ran; exit 0 when no measured check failed (on a PROVISIONAL verdict that isn't a GO decision), 1 NO-GO, 2 usage error. `--dry-run` (local only) runs Jest in Provino's place and prints NO-GO at ratio 1.000 |
| Resolver / transform corpora | `pnpm bench:resolve` (agreement with Node ESM; `--max-warm-us 15` adds the timing bar); `pnpm bench:excalidraw` (needs `.refs/excalidraw`, see `docs/plan/bundles/B05.md`; `--max-median-ms 0.5` adds the timing bar) |
| Expect bench          | `pnpm bench:expect` (passing `toBe`/`toEqual`, Provino vs `expect@30.5.2`, interleaved, `local`); `--max-tobe-us 1 --max-toequal-us 4` adds T7.3's bar |
| Loader checks         | `pnpm bench:loader check` (Spike A fixture, 600/600 and 0 isolation violations); `pnpm bench:loader isolation [--max-overhead-ms 1]`; `pnpm bench:loader e2e` (vs Jest + @swc/jest, a signal only); `pnpm bench:runner-fuzz` (10,000 generated TS files through the guarded runner transform) |
| Worker runtime check  | `pnpm bench:worker check` (app-500, Jest flavour, through one inline worker with the Jest dialect and `@provino/env-node`, under `registry` then `none`: 4,000/4,000 passing and 0 order violations in each; `--suite app-N`, `--pool inline\|threads\|forks`; `local`) |
| Record goldens        | `pnpm provino-harness record [<fixture dir>...]` (real Jest 30.5 / Vitest 5.0); `--check` fails on drift. One corpus alone: `pnpm record:runtime [--check]`, `pnpm record:expect [--check]` |
| Dependency updates    | `pnpm deps:check` (report only); `pnpm deps:update` runs only when Tyler asks (autd, D14) |

- **Node below 22.18** (the 22.15 floor) needs `NODE_OPTIONS=--experimental-strip-types` for `pnpm test` and `pnpm boundaries`; CI's 22.15 leg sets it. Node 24+ strips types by default.
- **A new package** adds itself to the root `tsconfig.json` references (and `packages/<name>/test` to `tsconfig.type-tests.json`), gives its `exports` a `provino-source` condition pointing at `src/`, and uses `catalog:` for shared dev tools.

## Git

Follow DECISIONS S2: a `task/<bundle>-<slug>` branch, small commits with `git commit -s -m "feat(<pkg>): …"`, push only your own task branch, never touch `main` directly, and never force-push.

## Library docs

Use the Context7 MCP server, when it's available, for current docs (Oxc, tsdown, Node APIs). If a pinned version has moved on since 2026-10-30, note it; don't silently upgrade.
