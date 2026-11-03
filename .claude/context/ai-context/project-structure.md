# Project structure

Current state after B03 (2026-11-02): `@provino/types` holds the contracts, `@provino/policy` the policy runtime, `@provino/core` the test runtime (B07), and `tooling/boundaries` checks package boundaries. Update this file whenever a top-level directory is added.

```
provino/
├── CLAUDE.md                     # always-loaded standards; keep under ~150 lines
├── LICENSE                       # MIT (DECISIONS D2); each published package carries a copy
├── package.json                  # private workspace root `provino-monorepo`; root scripts only
├── pnpm-workspace.yaml           # packages/*, minimumReleaseAge, the catalog of exact pins
├── tsconfig.base.json            # strict flags shared by every package (extended, never referenced)
├── tsconfig.json                 # solution: references every package's src project (`tsc -b`)
├── tsconfig.type-tests.json      # solution: references every packages/<name>/test project
├── turbo.json                    # per-package tasks: test (via transit), build, bench, record
├── biome.json                    # lint and format (D11); Markdown excluded; extends the generated plugin list
├── .dependency-cruiser.json      # generated from tooling/boundaries/packages.json; never hand-edit
├── .gitattributes                # marks generated files linguist-generated (collapsed in PR diffs)
├── .tool-versions                # asdf: Node and pnpm for local dev
├── .claude/
│   ├── context/ai-context/       # registry, architecture, structure, handoff.md (gitignored)
│   └── rules/                    # path-scoped rules; load only when matching files are touched
├── docs/                         # private provino-planning repo, gitignored here (CLAUDE.md)
│   ├── plan/                     # PLAN.md (status), DECISIONS.md (overrides research), bundles/<id>.md
│   └── research/                 # frozen research snapshots; reference only, never edit
├── packages/                     # one dir per package, named without the @provino/ scope
│   ├── types/                    # @provino/types: contracts only (policy, tree and events, loader, transform, resolver, environment, coverage, orchestrator, result model)
│   ├── policy/                   # @provino/policy: neutralPolicy, resolvePolicy, callBehaviour, serializePolicy, diffPolicy
│   ├── resolver/                 # @provino/resolver: createResolver over oxc-resolver; bench/ holds the Node ESM agreement check
│   ├── transform/                # @provino/transform: createPipeline (Oxc), toModuleRunner (D10 guard); bench/ holds the excalidraw and runner-fuzz checks
│   ├── loader/                   # @provino/loader: createLoader, the module-runner engine (none and registry tiers)
│   ├── core/                     # @provino/core: collector, executor, current test (B07)
│   ├── harness/                  # @provino/harness (dev): result converters, golden-fixture recorder, parity diffs
│   └── bench/                    # @provino/bench (dev): synthetic suites, provino-bench, and the loader benches (src/loader/)
├── tooling/                      # private workspace tools, never published (pnpm-workspace `tooling/*`)
│   └── boundaries/               # provino-boundaries: packages.json manifest, generator, GritQL plugins
├── .refs/                        # gitignored upstream sources at pinned commits (DECISIONS S3); excalidraw/ is GitHub's tarball (the sandbox blocks nested git)
└── .github/workflows/ci.yml      # Node 22.15/24/26 typecheck + test; type tests on TS 7.0.2 and 5.9.3; lint; recorded goldens on every push, bench suites when their inputs change; resolver/transform corpora
```

Gitignored build output: `packages/*/.tsc/` (declarations from `tsc -b`; project references need emit) and `.turbo/`.

Planned, not yet created: the other `packages/*` (see `monorepo-architecture.md`), the `provino-site` app (T12.18 places it), `compat/*.snap.md` (T12.20), `crates/provino_native` (Phase 3).

## Inside a package

```
packages/<name>/
├── package.json        # exports: "provino-source" → ./src/…ts first, then types/import → ./dist/…
├── tsconfig.json       # extends ../../tsconfig.base.json; include ["src"] (unit tests included)
├── src/                # source, plus *.test.ts unit tests next to it
├── bench/              # optional: corpus and benchmark scripts, their own tsconfig project (referenced from the root tsconfig.json)
├── fixtures/           # optional: committed fixture data (e.g. transform's excalidraw.json manifest)
└── test/
    ├── tsconfig.json   # type-test project; references ".."
    └── *.test-d.ts     # expect-type tests
```

## Where things go

| Thing                               | Location                                                            |
| ----------------------------------- | ------------------------------------------------------------------- |
| Package source                      | `packages/<name>/src/`                                              |
| Unit tests                          | next to source as `*.test.ts` (node:test)                           |
| Type tests                          | `packages/<name>/test/*.test-d.ts`                                  |
| Ground-truth and golden fixtures    | `packages/harness/fixtures/<area>/`                                 |
| Synthetic bench suites              | generated by `@provino/bench`; never committed when output is large |
| Vendored upstream code              | `packages/<name>/src/vendor/` with `UPSTREAM.md`                    |
| New decisions                       | `docs/plan/DECISIONS.md` (Proposed)                                 |
| Known divergences from Jest/Vitest  | `docs/plan/DIVERGENCES.md`                                          |
| Bundle mini-briefs and gate reports | `docs/plan/bundles/<id>.md`                                         |

## Commands

See `CLAUDE.md` → Commands. That table is the single source; don't duplicate it here.
