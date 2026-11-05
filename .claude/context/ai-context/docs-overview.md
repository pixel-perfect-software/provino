# Documentation Registry

Tier 1 is project-wide. Read a Tier 1 file only when the task needs it; `.claude/rules/` files load on their own when you touch matching paths, so don't pre-read them. Tier 2 files are nested `CLAUDE.md` files that load on their own under their directory. Reference docs are never loaded automatically: open only the section a task names.

## Tier 1 — Foundational

- `CLAUDE.md`: standards, non-negotiables, commands, git workflow.
- `.claude/context/ai-context/handoff.md`: where the last session stopped. **Read first in every session** (it is created after the first session). Gitignored, so each checkout and worktree keeps its own.
- `.claude/context/ai-context/monorepo-architecture.md`: package map, layers, dependency rules, coordinator vs worker placement. Read before creating a package or adding an import between packages.
- `.claude/context/ai-context/project-structure.md`: directory tree, stack and where things go. Read before adding a top-level directory.
- `.claude/rules/benchmarks.md`: rules for `packages/bench/**`.
- `.claude/rules/dialects.md`: rules for `packages/dialect-*/**`.
- `.claude/rules/tests.md`: rules for tests, type tests, fixtures and goldens.
- `.claude/rules/typescript.md`: rules for all package source.
- `.claude/rules/vendored-upstream.md`: rules for code copied from Jest or Vitest.
- `docs/plan/DECISIONS.md`: decided, default, proposed and open decisions, plus the precedence order. Overrides all research.
- `docs/plan/DIVERGENCES.md`: known, deliberate differences from Jest/Vitest (DECISIONS S5). Created on first use.
- `docs/plan/bundles/<id>.md`: per-bundle mini-briefs, corpus rebuilds and gate reports. Read the one for your bundle.
- `docs/plan/PLAN.md`: how to run a bundle, plus bundles, gates, status and the task index. At the start of a bundle, read from the top through "Stages and gates"; after that, Grep for a bundle ID. Don't read the whole file.

## Tier 2 — Component

When a package gains non-obvious structure, add `packages/<name>/CLAUDE.md` (under ~150 lines) and list it here, alphabetically.

- `packages/config/CLAUDE.md`: loading a config file and resolving a project from it (dialect selection, policy layering, environment, isolation, the worker's `SerializedProjectConfig`), the `ConfigError` codes, and what is still stubbed (with owning tasks).
- `packages/core/CLAUDE.md`: the runtime's module map, one store per test attempt, the per-attempt order, the two focus algorithms, how the corpus check runs core, and what is still stubbed (with owning tasks).
- `packages/dialect-jest/CLAUDE.md`: the Jest dialect's value (`jestDialect`, `jestPolicy`) and globals (`jestGlobals`), its `expect` slice and matcher table, the vendored Jest matchers (their own tsconfig project, D17), and its tests.
- `packages/env-node/CLAUDE.md`: how the Node environment restores the global (what is compared, the key-order limit, what an unrestorable key does, why setup reads every descriptor first).
- `packages/expect/CLAUDE.md`: the neutral expect engine (front end, per-attempt state, slot), the stack-anchoring rule, the worker's boot order, and what is still stubbed (with owning tasks).
- `packages/harness/CLAUDE.md`: the golden-fixture format and recorder (one format for every golden), converters, normalization and parity diffs.
- `packages/loader/CLAUDE.md`: the engine's worker-wide and per-file halves, the module-runner wrapper shape, and what is still stubbed (with owning tasks).
- `packages/orchestrator/CLAUDE.md`: the coordinator and worker halves (transports, `connectWorker`, `startWorker`, packer, console capture), how a worker boots and exits, the exit-reporting and link rules, the coordinator's run (`runProject`: discovery, results cache, sequencer, pool, event dispatch, exit codes), the end-to-end tests, and what is still stubbed (with owning tasks).
- `packages/provino/CLAUDE.md`: the umbrella's `provino/node` `run()` (what it wires, how errors become exit codes), the `provino` bin, and the end-to-end tests including the segfault check.
- `packages/reporters/CLAUDE.md`: the reporter bus (ordering, how a throwing reporter is handled), the default reporter's format and tallies, how the normalized-json reporter builds a `NormalizedRun`, and what is still stubbed (with owning tasks).
- `tooling/boundaries/CLAUDE.md`: the package manifest, what is generated from it, and how to add a package or rule.

## Reference (read when named)

- `docs/research/build-plan.md`: §1 per-track task tables with "Done when" checks · §3 briefs for B01–B12 · §4 known plan problems · §5 open questions · §6 coordinator resolutions · §7 Tyler's decisions.
- `docs/research/tracks/track-01-architecture.md`: package map, `Policy` slices, `Dialect`, extension points, config types, toolchain.
- `docs/research/tracks/track-02-loader-isolation.md`: loader engines, isolation tiers (`none` / `registry` / `realm`), FileRegistry.
- `docs/research/tracks/track-03-transforms-resolution-caching.md`: oxc-resolver, Oxc pipeline, hoisting, transform cache.
- `docs/research/tracks/track-04-mocking-fake-timers.md`: mock functions, module mocks, fake timers, mock policies.
- `docs/research/tracks/track-05-test-api-runtime.md`: collector, executor, hooks, current-test ALS, RuntimeEvent.
- `docs/research/tracks/track-06-lazy-variables.md`: the lazy API, LazyHost, type encoding, lint rules.
- `docs/research/tracks/track-07-expect-snapshots.md`: expect front end, matchers, snapshot state machine.
- `docs/research/tracks/track-08-environments-coverage.md`: node/jsdom/happy-dom environments, V8 and Istanbul coverage.
- `docs/research/tracks/track-09-orchestration.md`: pools, transport, scheduler, reporters, watch, exit codes.
- `docs/research/tracks/track-10-native-core-distribution.md`: Rust core (Phase 3), platform packages, trusted publishing.
- `docs/research/tracks/track-11-compatibility-layer.md`: Jest and Vitest config readers, CLI flags, facades, IDE contracts.
- `docs/research/tracks/track-12-verification-benchmarks.md`: differential harness, corpus, benchmark protocol, R6 kill criterion, the site.
- `docs/research/benchmarks-quiet-rerun.md`: re-measured spike numbers. Read before quoting any research figure.
- `docs/research/next-gen-test-runner-research.md`: the Oct 29 starting research. Background only; superseded where the tracks disagree.
