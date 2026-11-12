# tooling/packaging

How Provino's packages are built, packed and checked (B21e: T1.6, T1.10, T7.12, T10.1, T10.2, T10.4's agent half). Private; never published. It has a manifest node (`provino-packaging`, layer `tooling`, no workspace deps), and no package imports it: the build scripts and the root scripts run files in it.

## Map

| File | Role |
|---|---|
| `src/preset.ts` | `PRESET` (tsdown: `format: 'esm'`, `platform: 'node'`, `target: 'node22.15'`, `dts.generator: 'oxc'`, `fixedExtension: false` so `.js` and `.d.ts`, `hash: false`) and `packageConfig(dir)`: one entry per `exports` subpath that has a `provino-source` `.ts` file, named by its `import` target (`./dist/node/index.js` is entry `node/index`); `types` must be `./dist/<name>.d.ts`. A package whose subpaths have no `import` condition (`@provino/types`, T1.2) is built as declarations only (`emitDtsOnly`); mixing the two fails. `deps.onlyBundle: []` and `deps.onlyImport` (own name and declared dependencies) make a build fail on an undeclared import instead of bundling it |
| `tsdown.config.ts` | What every package's `build` script points at (`tsdown --config ../../tooling/packaging/tsdown.config.ts`); runs in the package's directory and reads its package.json |
| `src/umbrella.ts`, `tsdown.umbrella.config.ts` | The `provino` build: see "The umbrella" |
| `src/hygiene.ts` and its parts | `pnpm hygiene`: sections `install-scripts`, `changeset-config`, `umbrella-deps`, `release`, `packs`, `api`, `knip`. Each reports; a section that throws fails as that section |
| `src/pack.ts`, `src/lint-pack.ts` | `pnpm pack` per package (never `npm pack`: only pnpm rewrites `workspace:` and `catalog:` and applies `publishConfig`, D75), then publint (`--strict`, level `suggestion`, must print "All good!") and `attw --profile esm-only` on the tarball |
| `src/api-reports.ts`, `src/changesets.ts`, `src/git.ts` | API Extractor per entry point of the semver packages, `etc/<package>[-<entry>].api.md` committed in the package; the changeset gate |
| `src/install-scripts.ts`, `src/release-lint.ts`, `templates/release.yml` | The T10.4 checks: the install-script ban, and the release workflow lint with the draft it passes |
| `src/smoke.ts` | `pnpm smoke:install`: pack, install `provino` from its tarball into an empty temp directory with pnpm, `provino --version` and a 3-file suite (the injected globals, `import … from 'provino'`, a TypeScript test) |
| `src/exec.ts`, `src/package-json.ts`, `src/workspace.ts` | `runCommand` (stdout then stderr, no colour, a deadline), `binScript` (a package's bin without importing its package.json), the package.json reader, the workspace and `SEMVER_PACKAGES` |
| `src/*.test.ts` | The planted cases (below) |

## The umbrella (T1.10)

`provino` ships one bundle. `umbrellaConfig` returns two tsdown builds (JavaScript, then declarations: the chunk groups of the first would name the declarations' intermediate chunks too, and one overwrote the other). Every `@provino/*` package is inlined from source (the `provino-source` condition); the third-party packages `provino` lists in `dependencies` stay external, and `deps.onlyImport` fails the build on anything else. `provino`'s devDependencies are the `@provino/*` packages it inlines (`workspace:*`); `umbrella-deps` fails when its `dependencies` stop being what those packages (and theirs) need.

- **Worker modules by file (D21).** A coordinator resolves `import.meta.resolve('@provino/dialect-jest/runtime')` and the worker imports the answer. The plugin `workerRefs` rewrites each such call to a URL of that entry's file in this build (`WORKER_ENTRIES`: `worker/bootstrap`, `worker/main`, `worker/jest-runtime`, `worker/policy-behaviours`, `worker/env-node`, `worker/env-jsdom`), so coordinator and worker share one copy of the engine. A `@provino/…` specifier the table lacks fails the build; `umbrella.test.ts` checks the table against every call in the shipped sources, and that each argument is a literal.
- **One shared chunk.** `codeSplitting.groups` puts every module more than one entry uses in `shared.js` (about 380 kB), so a worker's cold start is six files from the package: `worker/bootstrap.js`, `shared.js`, `worker/main.js`, `worker/jest-runtime.js`, `worker/policy-behaviours.js`, `worker/env-node.js` (`packages/provino/test/exports.test.ts` counts with a `registerHooks` recorder; Node 24 has no `node.module` trace category). The cost is that a worker loads coordinator code that sits in the same chunk. `entriesAware: true` splits it by sharing set, but names chunks with `/` and gives the worker more files.
- **The bin.** `bin` stays `./src/cli.ts` in the workspace (the bench and harness read it); `publishConfig.bin` is `./dist/cli.js`, which `pnpm pack` writes into the tarball.

## Planted cases

Every check has a case that must fail, and a real-repo case that must pass.

| Gate | Test | Plant |
|---|---|---|
| untagged export | `gates.test.ts` | a `.d.ts` with an export lacking a release tag: API Extractor `ae-missing-release-tag` |
| `@public` change with no changeset | `gates.test.ts`, `checks.test.ts` | reports with a changed `@public` signature (and a `@beta` one that isn't a change); a temp git repo for the changesets added since the base |
| publint, attw | `gates.test.ts` | a missing types file, CommonJS under `"type": "module"`, an `exports` an `import` can't resolve |
| install script | `checks.test.ts` | `preinstall`, `install`, `postinstall` in any package, private or not, and the root |
| release workflow | `checks.test.ts` | each property removed from the draft (`id-token`, a token, a plain publish, no provenance, a self-hosted runner, a PR trigger, no publish step) |
| knip | `umbrella.test.ts` | a scratch project with an unused file, and one with an undeclared import |
| T7.12's ban list | `tooling/boundaries/src/planted.test.ts` | a runtime import of each banned package, flat and pnpm layouts |

## Choices and gotchas

- **Tiers.** D67's semver packages (`SEMVER_PACKAGES`) have committed API reports and the changeset gate. The other published packages are `@beta` as a whole: their `@public` tags (the whole tree uses them) mark an export as intended, and promise nothing, so they have no report. Retagging them would touch every package.
- **API Extractor** runs with `newlineKind: 'lf'`, `localBuild: true` into a temp folder (the committed report is compared by hand, so a difference needs a changeset and not only a rewrite), and `ae-forgotten-export` off (a bundled declaration file keeps the types it doesn't export). Reports are per entry point because it takes one; its own TypeScript is 6.0.3.
- **The changeset gate** compares the report at the base ref (`git show <base>:<path>`) with the one on disk (or the one `--update-api` writes) and looks for `.changeset/*.md` added since (committed, staged or untracked). A base it can't resolve fails the run.
- **knip** treats exports and exported types as warnings (a baseline of about 80 and 30, mostly vendored code and test helpers). `knip.jsonc` lists, with a reason, each dependency a static read can't see.
- **The release lint reads text, not YAML** (no YAML parser is a dependency). It strips comments and checks the lines. A draft carries `--dry-run` on every publish.
- **Biome owns formatting of `packages.json`;** the manifest edit that added `provino-packaging` and the ban lists went through `biome format`.

## Not built (B21h, D73)

No file under `.github/`: the hygiene job, `install-matrix.yml` (OS × package manager × Node, Verdaccio, the alpine job, the three T10.3 cases) and `release.yml` (copy `templates/release.yml`; `pnpm hygiene` then lints it) are B21h's.
