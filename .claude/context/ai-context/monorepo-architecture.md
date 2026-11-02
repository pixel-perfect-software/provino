# Monorepo architecture

The source of truth is Track 1 §Module boundaries, amended by build-plan §6. This file is the working summary. If you need to change the map, propose it in DECISIONS.md and ask Tyler.

## Shape

Many small **source** packages with enforced boundaries, published as few **install** units. Every package lives at `packages/<name>/`, where `<name>` is the package name without the `@provino/` scope (`packages/types`, `packages/dialect-jest`). The umbrella is `packages/provino` (unscoped `provino`). Its tsdown build pre-bundles the worker hot path (core, lazy, expect, mock, timers, loader) so worker startup loads only a handful of files.

## Package map

Dependencies point **down** the layers only. Same-layer edges are allowed only where listed. Any edge not listed fails CI. The machine-readable map is `tooling/boundaries/packages.json` (B03): `pnpm boundaries` checks it against the workspace and runs the dependency-cruiser rules generated from it. A change to the map goes in both this table and the manifest.

| Layer | Package | Runs in | Owns | May depend on |
|---|---|---|---|---|
| 0 | `@provino/types` | types only | Task tree, events, RPC messages, `Policy` and its slices, `Dialect`, extension contracts, config types, registries (`DialectRegistry`, `PluginRegistry`, `Matchers`) | nothing (`@standard-schema/spec` types) |
| 1 | `@provino/policy` | both | Neutral defaults, `resolvePolicy`, `defineDialect`, `callBehaviour`, `diffPolicy` | types |
| 1 | `@provino/rpc` | both | Typed channel over MessagePort/IPC, codecs, `SerializedError` | types |
| 1 | `@provino/resolver` | both | oxc-resolver wrapper, mappers, conditions, specifier aliases (U9) | types |
| 1 | `@provino/native` (+ `-<platform>`) | both | Rust core, Phase 3 only; same TS interfaces as the JS it replaces | types |
| 2 | `@provino/transform` | both | Oxc pipeline, mock hoisting, transform cache, module-runner rewrite | types, resolver |
| 2 | `@provino/snapshot` | both | Snapshot engine (`/runtime`, worker) and write-back (`/node`, coordinator) | types, policy |
| 2 | `@provino/coverage` | both | V8 collection (worker), convert, merge and report (coordinator) | types |
| 2 | `@provino/mock` | worker | `fn`, `spyOn`, module-mock registry | types, policy |
| 2 | `@provino/timers` | worker | Fake timers | types, policy |
| 2 | `@provino/expect` | worker | `expect`, matchers, asymmetric matchers | types, policy, snapshot `/runtime` |
| 3 | `@provino/loader` | worker | Loader engines, isolation tiers, `registerHooks` glue | types, policy, resolver, transform, mock |
| 3 | `@provino/core` | worker | Collector, executor, hooks, context, **definition table and `fixtures.compile`** (§6), current-test ALS | types, policy |
| 3 | `@provino/env-node`, `-jsdom`, `-happy-dom` | worker | `Environment` implementations | types |
| 4 | `@provino/lazy` | worker | Lazy variables, built on core's public API through `LazyHost`; core never imports lazy | types, core |
| 4 | `@provino/config` | coordinator | `defineConfig`, loading `provino.config.ts`, validation, projects, dialect selection, the shared TS config loader (§6) | types, policy, transform |
| 4 | `@provino/reporters` | coordinator | Reporter bus, built-ins, `normalized-json` (U4) | types |
| 5 | `@provino/orchestrator` | coordinator | Coordinator, pools, scheduler, watch | types, policy, rpc, config, reporters, resolver, snapshot `/node`, coverage `/node` |
| 5 | `@provino/orchestrator/worker` (subpath entry, its own manifest node) | worker | Worker entry: wires loader → core via `ImportFile`, environments by `ModuleRef`, runs files (U1) | types, policy, rpc, loader, core, lazy, expect, mock, timers, snapshot `/runtime`, coverage (worker side); never the coordinator entry |
| 5 | `@provino/dialect-jest`, `@provino/dialect-vitest` | both | `Dialect` value; `/node` (config reader, flags, reporter adapters) and `/runtime` (facades, globals) | types, policy; `/node` also config, resolver, transform; `/runtime` also core, lazy, expect, mock, timers |
| 6 | `provino` | both | CLI bin, public subpaths (`.`, `/globals`, `/config`, `/node`, `/reporters`, `/environment`, `/plugin`, `/jest`, `/vitest`) | all public packages |
| dev | `@provino/harness`, `@provino/bench` | dev | Differential harness, golden recorders, benchmarks, kill-check | types and helpers from any `@provino/*`; **run** Provino only via `provino/node` (DECISIONS S4); real Jest/Vitest as subjects |

Added by §6, created only when their phase arrives: `@provino/vitest-compat` and `@provino/jest-globals` (Phase 2 facades), `@provino/eslint-plugin` and `@provino/codemod-lazy` (Phase 4), `@provino/dialect-node-test` (Phase 4, private), the `provino-site` app (T12.18). `@provino/env-shared` only if two environment packages share `populateGlobal`. All are listed in the manifest already (`dir` is `null` for `provino-site` until T12.18 places it).

**Subpath entries.** A manifest node named `<package>/<entry>` (`@provino/orchestrator/worker`, `@provino/snapshot/runtime`, `@provino/dialect-jest/node`, …) owns `packages/<package>/src/<entry>/**` and has its own rules; the package node owns the rest. Put a subpath entry's code in that directory.

**Policy slices** (10): Track 1's nine plus `coverage`. B03's merge record is `docs/plan/bundles/B03.md`.

## Dependency rules (enforced in CI by B03)

Rule names, as CI prints them: dependency-cruiser `boundary-<node>` (a package with subpath entries also gets `boundary-<package>-test` for its `test/` dir), `neutral-no-dialect`, `public-entry-only`, `not-to-unresolvable`, `no-circular`; Biome plugins `neutral-no-dialect-name`, `slice-discipline` (both skip `*.test.ts` and `*.test-d.ts`); the `pnpm boundaries` checks `manifest-*`, `workspace-*` and `no-plugin-suppression`.

1. **Layers point down.** dependency-cruiser `forbidden` rules are generated from the manifest.
2. **No dialect knowledge in neutral packages.** `core`, `lazy`, `mock`, `timers`, `expect`, `snapshot`, `loader`, `orchestrator`, `reporters` and `config` never import `@provino/dialect-*` and never name `'jest'` or `'vitest'` in a string, template literal or object key (a Biome GritQL plugin, D11).
3. **Slice discipline.** A package imports only its own `*Policy` slice type, and its public functions take that slice, never the whole `Policy`. It also never uses the `@provino/policy` values that hand out every slice (`neutralPolicy`, `resolvePolicy`, …); its tests may. Exempt: `policy`, `config`, `orchestrator` (it ships `SerializedPolicy`) and the dialects.
4. **Public entry only.** Cross-package imports go through `exports`. Deep imports fail.
5. **Coordinator and worker never import each other's packages**, except through `@provino/types` and `ModuleRef` strings. This is why snapshot, coverage and the dialects split into `/node` and `/runtime`.
6. **Core does not import the loader.** The worker entry injects `ImportFile`, so core also runs with no loader in unit tests.
7. **No cycles, no hidden globals.** A cycle made only of type-only imports is allowed (contract types refer to each other; DECISIONS D15). State lives in an explicit `WorkerContext` or in core's AsyncLocalStorage.

## Cross-thread contracts

- One typed RPC channel per worker (`@provino/rpc`, used by the orchestrator). Every argument and result must satisfy `CloneSafe<T>`. A method that takes a function is a compile error.
- **One event model** (§6): Track 5's `RuntimeEvent` is the source. Track 9's `WorkerEvent` is its batched wire form, flushed at the end of each macrotask or every 64 events. Track 12's `HarnessEvent` is derived from it in the `normalized-json` reporter.
- Policy crosses as `SerializedPolicy`: data keys as values, behaviour keys as `ModuleRef` only.
- Snapshot I/O (§6): the worker resolves paths and writes `.snap` files. The coordinator applies only inline-snapshot edits, once per source file.
