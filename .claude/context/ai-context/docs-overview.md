# Documentation Registry

Tier 1 is project-wide. Read a Tier 1 file only when the task needs it; `.claude/rules/` files load on their own when you touch matching paths, so don't pre-read them. Tier 2 files are nested `CLAUDE.md` files that load on their own under their directory. Reference docs are never loaded automatically: open only the section a task names.

## Tier 1 — Foundational

- `CLAUDE.md`: standards, non-negotiables, commands, git workflow.
- `README.md`: the public front page, kept short in the house style of Pixel Perfect's other READMEs (centered logo, tagline and badges; a real `provino jest` run; Features, Requirements, Install, Getting started, Commands; links into `wiki/`). Longer explanations go in `wiki/`, not here.
- `CONTRIBUTING.md`: setup, commands and conventions for human contributors. It doesn't repeat this file's agent rules.
- `wiki/`: the longer public docs the README links to: `why-provino.md` (the problem, goal and go/no-go bar), `compatibility.md` (what `provino jest` does and the full gap table: when a gap closes or a flag stops being refused, update it here), `how-it-works.md`, `troubleshooting.md`.
- `THIRD_PARTY_NOTICES.md`: the license for code copied from other projects. Five packages (`provino`, `@provino/dialect-jest`, `@provino/dialect-vitest`, `@provino/snapshot`, `@provino/env-shared`) ship a copy, which `pnpm hygiene` holds equal to it.
- `packages/*/README.md`: each published package's npm page (`packages/provino/README.md` is the one users read; the others say they are building blocks inlined into `provino`, and whether D82 gives them semver).
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

- `packages/bench/CLAUDE.md`: where the bench's pieces are (including `list-tests`), how the kill-check reads each R6 check, what its verdict and record hold, the dry run, and what today's numbers do and don't include.
- `packages/config/CLAUDE.md`: loading a config file (`importConfigModule`, the one config-module loader) and resolving a project from it or from a dialect reader's `NeutralProject` (`resolveNeutralProject`): dialect selection, policy layering, environment, isolation, the worker's `SerializedProjectConfig`, the `ConfigError` codes, and what is still stubbed (with owning tasks).
- `packages/core/CLAUDE.md`: the runtime's module map, one store per test attempt, the per-attempt order, the two focus algorithms, how the corpus check runs core, and what is still stubbed (with owning tasks).
- `packages/dialect-jest/CLAUDE.md`: the Jest dialect's value (`jestDialect`, `jestPolicy`) and globals (`jestGlobals`), its `expect` slice and matcher table, the vendored Jest matchers (their own tsconfig project, D17), the config reader (`./node`: find, load, presets, normalize, validate, neutral projects, each rebuilt from jest-config 30.5.2 and checked against it; `jestNodeDialect`), the command-line parser (`jestCli`, rebuilt from jest-cli's `buildArgv`), and its tests.
- `packages/dialect-vitest/CLAUDE.md`: the Vitest dialect's value (`vitestDialect`, `vitestPolicy`, the mock, module and hoisting slices moved from the harness), the `/node` and `/runtime` stubs, where its values' evidence is, and its defaults check.
- `packages/env-shared/CLAUDE.md`: `populateGlobal` and its exact restore (Vitest 5.0.5's semantics, descriptors not values), the vendored key list, and what the DOM environments add on top.
- `packages/env-jsdom/CLAUDE.md`: Provino's own jsdom environment (what `setup` builds and bridges, the options, why `customExportConditions` is read by the policy, who reaches it under D44, what is not copied from Vitest).
- `packages/env-node/CLAUDE.md`: how the Node environment restores the global (what is compared, the key-order limit, what an unrestorable key does, why setup reads every descriptor first).
- `packages/expect/CLAUDE.md`: the neutral expect engine (front end, per-attempt state, slot), the stack-anchoring rule, the worker's boot order, and what is still stubbed (with owning tasks).
- `packages/harness/CLAUDE.md`: the golden-fixture format and recorder (one format for every golden; `config`, `files` and black-box `run` fixtures), converters, normalization and parity diffs, the sidecar reporters and `runSubject`, the self-test sample and its recording, the `diff`, `convert` and `self-test` commands, and the policy ground truth (T1.7: `policy-truth/`, the claim kinds, `policy-diff`).
- `packages/lazy/CLAUDE.md`: the lazy-variable runtime (definition table, resolution and memo rules, scopes, cleanup, eager, the handle), the fake host its tests use, the core check in `@provino/bench`, and what is still stubbed (with owning tasks).
- `packages/loader/CLAUDE.md`: the engine's worker-wide and per-file halves, mocks on every edge (the injected module-mock registry, the actual paths, late imports), the interop shapes, per-module scope bindings, its message codes, the module-runner wrapper shape, and what is still stubbed (with owning tasks).
- `packages/mock/CLAUDE.md`: the neutral mock engine (mock functions, spies, the per-file registry), what the 1 µs creation bar forces on its layout, how methods work detached, its message codes, and what is still stubbed (with owning tasks).
- `packages/orchestrator/CLAUDE.md`: the coordinator and worker halves (transports, `connectWorker`, `startWorker`, packer, console capture), how a worker boots and exits, the exit-reporting and link rules, the coordinator's run (`runProject`: discovery by globs or by a dialect reader's rules, file filters, results cache, sequencer, pool, event dispatch, exit codes), the end-to-end tests, and what is still stubbed (with owning tasks).
- `packages/provino/CLAUDE.md`: the umbrella's `provino/node` `run()` (what it wires, how errors become exit codes), the `provino` bin and its commands (`run`, `jest`, `vitest`, bare), and the end-to-end tests including the segfault check.
- `packages/reporters/CLAUDE.md`: the reporter bus (ordering, how a throwing reporter is handled), the text reporters (`default`, `verbose`, `agent`, `dot`: the format Jest's recordings fix, the console block, the live view, colour), `detectOutput` (terminal, CI, agent, colour), `junit` (validated against the vendored Jenkins XSD), `github-actions`, how `json` builds a `NormalizedRun` (console per test by `taskId`), the goldens, and what is still stubbed (with owning tasks).
- `packages/timers/CLAUDE.md`: the fake clock (`createFakeClock`, `FakeClock`) over `@sinonjs/fake-timers`, the timer members of `jest` and `vi`, how each `TimersPolicy` value changes it, the async-context binding of every scheduled callback, and what is not built (legacy timers).
- `packages/resolver/CLAUDE.md`: the resolver, and its corpus bench (`pnpm bench:resolve`): what it requests, why the workspace's own packages are left out, and how a missing `exports` target is read.
- `packages/snapshot/CLAUDE.md`: the snapshot engine's three entries (the `.snap` format, the per-file `SnapshotState` and its lifecycle, the coordinator's update mode and totals), what a dialect supplies (policy values, the printer, the key function), the differences it reproduces and the ones it doesn't, and what is still stubbed (with owning tasks).
- `packages/transform/CLAUDE.md`: how the hoister is laid out, the import rewrite (D36) and its output shape, how the pipeline runs it, the transform cache, the V8 code cache and Node's compile cache helper (`@provino/transform/v8cache`, T3.7), and what is still stubbed (with owning tasks).
- `tooling/boundaries/CLAUDE.md`: the package manifest, what is generated from it, and how to add a package or rule.
- `tooling/packaging/CLAUDE.md`: the shared tsdown preset, the `provino` bundle (what is inlined, how worker modules are found by file, the shared chunk), `pnpm hygiene` and each check's planted case, the API reports and changesets, the release workflow lint and the install smoke.

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
