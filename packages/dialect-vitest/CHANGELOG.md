# @provino/dialect-vitest

## 0.1.0-rc.12

### Patch Changes

- 22f6272: Work a native jsdom file left queued no longer fails its last test with `window is not defined`. When the file's window is about to close, the worker runs the file's pending `setImmediate` and 0 ms `setTimeout` work while the window is still there (at most 50 turns or 50 ms), so a React commit that lands as the test ends runs, and React's scheduler still works in the next files. Then it clears the file's `setImmediate` and `setTimeout` work that is still pending, so none of it fires into the next file. Intervals and message ports are left alone, since a package shared by the worker's files may keep them. The new policy key is `orchestrator.windowFileWork` (`drain-then-cancel` for native projects, `outlives-file` for the Jest and Vitest dialects, which keep their behaviour). A timer cleared by its numeric id or through `node:timers` no longer holds up the wait, and a timeout that fired and was `refresh()`ed is still cleared. The default reporter now prints a dependency's stack frames for an error whose every frame is a dependency's or Node's, where it used to print none; where the error happened (a GitHub Actions annotation, the `provino` reporter's location) still comes from the user's own frames only.
- Updated dependencies [22f6272]
  - provino@0.1.0-rc.12

## 0.1.0-rc.11

### Patch Changes

- cfb5974: A native project can import an asset or a style file. `import logo from './logo.svg'` is the file's URL as a Vite dev server writes it (`/src/logo.svg`, or `/@fs/<path>` outside the project root), a `.css` or `.scss` import is an empty module, and a `*.module.css` import is an object that answers each name with itself. `?raw` imports the file's text and `?url` its URL. A `mock()` of the file still wins, so does a transform the project configures for it, and a dependency's own asset or stylesheet import works too. Projects on the Jest or Vitest dialect are unchanged.
- Updated dependencies [514f338]
- Updated dependencies [bb82b45]
- Updated dependencies [8660a21]
- Updated dependencies [2ae79f4]
- Updated dependencies [cfb5974]
- Updated dependencies [b2ab699]
  - provino@0.1.0-rc.11

## 0.1.0-rc.10

### Patch Changes

- Updated dependencies [4a3ad73]
- Updated dependencies [43cab28]
- Updated dependencies [b4b4581]
- Updated dependencies [921fde7]
  - provino@0.1.0-rc.10

## 0.1.0-rc.9

### Patch Changes

- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
  - provino@0.1.0-rc.9

## 0.1.0-rc.8

### Patch Changes

- Updated dependencies [4534450]
  - provino@0.1.0-rc.8

## 0.1.0-rc.7

### Minor Changes

- 9f7b73d: The Vitest command line (`vitestCli` in `@provino/dialect-vitest/node`: Vitest 5.0.5's `parseCLI` and its checks, rebuilt) and the first of Vitest's results (`@provino/dialect-vitest/results`: `createVitestResults`, its `json` document). `provino vitest` runs a Vitest project once, as `vitest run` does, with Vitest's exit codes, `--reporter=json`, `--outputFile`, `--shard` (Vitest's split, `orchestrator.shard.fallback: 'rooted-sha1-slice'`), `--project`, `--bail`, `--passWithNoTests` and the variables Vitest's CLI sets; bare `provino` runs a Vitest project the same way. Every flag, command, reporter option and config key it does not apply is refused by name, or warned about as not applied for a config key (D183: Vitest is parked after this release).
- e3cac0e: The dialects are add-on installs. `provino` no longer bundles `@provino/dialect-jest` or `@provino/dialect-vitest`, nor their Jest, Babel and Chai packages: install `@provino/dialect-jest` beside `provino`, at `provino`'s own version, to run `provino jest` (`pnpm add -D @provino/dialect-jest@<the provino version>`), and `@provino/dialect-vitest` for `provino vitest`. Without the add-on, or with one of another version, the command prints that install line, the version filled in, and exits 1 (`PROVINO_DIALECT_NOT_INSTALLED`, `PROVINO_DIALECT_VERSION_MISMATCH`); an add-on that runs on another copy of `provino` than the one running (a global install, `pnpm dlx`) is refused the same way, naming both (`PROVINO_DIALECT_OTHER_PROVINO`). The add-on is resolved from the project's own install, from the config's directory. `ConfigError` gains `subject`: the dialect or top-level key it refused. Each dialect names `provino` as a peer and runs on its engine through `provino/internal/*` subpaths, which are internal and promise no semver. A project that uses only `provino.config` installs nothing from Jest or Vitest.

### Patch Changes

- 28c95d9: Fixtures in core: `test.extend` (object, `[value, options]` and builder forms) and `test.override`, with `test`, `file` and `worker` scopes, `auto` and `injected` entries and cleanups after `afterEach`, under the neutral policy and the Vitest dialect (Vitest 5.0.5's fixture errors, word for word); the Jest dialect's `test` has neither. `LazyHost.definitions` holds each suite's definition table, which lazy values now live in.
  
  `LazyHost` now requires `definitions(suite)`: a host you implement yourself (as `@provino/lazy`'s tests do) must add it, returning one `Map` per suite handle. The policy gains `core.definitions.plainSuiteHook` (`pass-suite` for the neutral policy and Jest, `refuse-fixtures` for Vitest).
- 12a9b2b: `provino vitest` resolves a project's `environment` (the config's, `--environment`) as a file's docblock is resolved, with `vitestEnvironmentRef` (now exported from `@provino/dialect-vitest/node` too): `jsdom` over the project's own jsdom, Vitest's built-in `happy-dom` and `edge-runtime`, `vitest-environment-<name>` packages and paths. `--dom` runs every file in happy-dom, as Vitest's does. The Vitest dialect keeps `jsdom` and `happy-dom` files on the `registry` isolation tier, since Vitest sets them up on the worker's own global.
- 5a4dce2: The Vitest dialect's environments: `node`, `jsdom` (over the project's own jsdom), Vitest's built-in `happy-dom` and `edge-runtime` setups over the project's libraries, `vitest-environment-<name>` packages and paths, and the `@vitest-environment` and `@jest-environment` docblocks with their options. An externalized package that registers a hook or writes the global as it loads is evaluated again in each file, as Vitest's isolated files do.
- 1b058a4: The Vitest dialect's globals and `vi`: `vitestGlobals` builds the 19 globals Vitest injects, `vitestModuleScope` gives each module its own `vi` (Vitest 5.0.5's members, in its order) and serves `vitest`, `@vitest/expect`, `@vitest/spy` and `vitest/runtime`.
- c2e1bb1: `defineConfig({ dialect: 'jest' })` and `'vitest'` now type-check against the published packages. The dialects register their name on `DialectRegistry` by declaration merging, and the built declarations named `@provino/types`, which no install has, so `DialectName` was `never`. They now name `provino/config`, which exports `DialectRegistry`, `PluginRegistry` and `ProvidedContext` (augment those there). `provino`'s internal declarations no longer hold a second copy of the three.
- ce31acb: Error and help messages no longer name internal task ids. A non-empty `plugins` or `alsoServe` says `config key "plugins" isn't supported yet`; `provino --help` no longer says that a build loads the Jest dialect's code or points at the task that builds a refused flag; and the "not implemented yet", "not supported yet" and "not applied" texts of `provino run`, `provino jest` and `provino vitest`, the loader, the environments, core, the orchestrator, coverage, the transform and the inline snapshot matchers drop their task and decision references.
- 30b872f: The Vite bridge and plugin host. `@provino/dialect-vitest/vite-bridge` runs the project's own `vitest/node` `resolveConfig` when a Vitest config has plugins (every plugin's `config` and `configResolved` hook runs) and reads `test`, the JSX settings, the defines and the user's plugins, with a version and a code hash each; without Vite installed it warns once and skips the plugins. `@provino/transform/vite` hosts those plugins' `buildStart`, `resolveId`, `load` and `transform` hooks with a plugin context (`parse`, `resolve`, `warn`, `error`, `addWatchFile`, `getCombinedSourcemap`, `environment`); `\0` and query ids are virtual modules the host owns, `@vitejs/plugin-react` is skipped, and a dev-server hook or `this.getModuleInfo` fails with `VITE_HOOK_UNSUPPORTED` naming the plugin. `vite` is an optional peer of `@provino/transform`. `provino vitest` itself is still not available.
- ecc8972: The Vitest config reader: `@provino/dialect-vitest/node` finds `vitest.config.*` or `vite.config.*`, imports it natively (`vitest/config` is served by a stand-in, so reading a config loads neither Vitest nor Vite), applies `test` over Vitest's defaults and the command line over the file, resolves `test.projects` and the `.env*` files, and returns neutral projects; a config with plugins is marked for the Vite bridge. `@provino/resolver` gains `viteAliasMapper` (a `@provino/resolver/vite-alias` subpath), Vite's `resolve.alias` rule, and `@provino/types` gains `NeutralProject.mappers`, which carries it. Bare `provino` now detects a `vite.config.*` with a `test` key as a Vitest project. `provino vitest` itself is still not available.
- c2970a6: The Vitest dialect has its own `expect`: `@vitest/expect` 5.0.5's matchers (aliases, sinon-chai's names, `toSatisfy` and `toBeOneOf` included) over Provino's front end, failing with Chai's `AssertionError` and Vitest's messages and diff, with Chai loaded only on a failure or a Chai assertion (`expect(x).to.equal(1)`), `expect(value, message)`, and equality that judges values from another realm by their class. `ExpectTable` gains `assertionError`, `chain` and `equals` for it, its `messages` may leave the engine's own policy words out (`ExpectTableMessages`), `ExpectPolicy` gains `settlementCheck` and `messageArgument`, and A Vitest failure carries Vitest's diff (`SerializedError.diff` is now that text, and the dialect's `core.shapeTestError` adds it where an error has none). `SnapshotPolicy.mismatch: 'throw'` makes a snapshot that differs throw at the call, as Vitest's does. `@provino/expect` exports `policyMessages`, the one copy of the words for its async and counting policies.
- Updated dependencies [28c95d9]
- Updated dependencies [12a9b2b]
- Updated dependencies [5a4dce2]
- Updated dependencies [1b058a4]
- Updated dependencies [9f7b73d]
- Updated dependencies [6f49f83]
- Updated dependencies [7daea04]
- Updated dependencies [c730222]
- Updated dependencies [467aaf4]
- Updated dependencies [12ebe35]
- Updated dependencies [e3cac0e]
- Updated dependencies [c2e1bb1]
- Updated dependencies [021f020]
- Updated dependencies [2662c60]
- Updated dependencies [26b1b86]
- Updated dependencies [ce31acb]
- Updated dependencies [84407de]
- Updated dependencies [7b73d24]
- Updated dependencies [ba5e5f7]
- Updated dependencies [334af48]
- Updated dependencies [c8e34ba]
- Updated dependencies [30b872f]
- Updated dependencies [ecc8972]
- Updated dependencies [c2970a6]
  - provino@0.1.0-rc.7

## 0.1.0-rc.6

### Patch Changes

- @provino/policy@0.1.0-rc.6
  - @provino/types@0.1.0-rc.6

## 0.1.0-rc.5

### Patch Changes

- @provino/policy@0.1.0-rc.5
  - @provino/types@0.1.0-rc.5

## 0.1.0-rc.4

### Patch Changes

- @provino/policy@0.1.0-rc.4
  - @provino/types@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- @provino/policy@0.1.0-rc.3
  - @provino/types@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- Updated dependencies [d015c8e]
  - @provino/types@0.1.0-rc.2
  - @provino/policy@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- @provino/policy@0.1.0-rc.1
  - @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Minor Changes

- ddb10bf: Coverage groundwork for `provino jest`: `@provino/types` gains `IstanbulFileCoverageData`, `SerializedCoverageConfig`, `RunCoverageOptions`, `CoverageThresholdGroup`, `CompiledModuleInfo`, `CoverageSummary.map`, `SerializedProjectConfig.coverage` and `NeutralProject.coverage`; the `coverage` worker event's `fileId` may be `null`; and the `coverage` policy slice gains `v8Conversion`, `v8HitCounts`, `istanbulVariable` and `thresholdMessages` (Jest's texts and values in `@provino/dialect-jest`). The transform pipeline takes an `instrumenter`. Nothing collects coverage yet.
- 475232b: The first built packages: each ships ESM and declarations in `dist`, and its API is reported in `etc/` and checked by `pnpm hygiene`. `provino` gains the `.`, `/globals`, `/config`, `/reporters`, `/environment` and `/jest` entry points beside `/node`, and a `--version` flag.
- 3872fb2: `provino jest` runs the project's `globalSetup` and `globalTeardown` in the coordinator, as Jest does: once per distinct path, in the order Jest's sequenced list reaches the projects, then the root config's own hooks (Jest's `globalConfig.globalSetup`, with `projects`), with `(globalConfig, projectConfig)`, through the project's transform (a TypeScript file, or one babel-jest or ts-jest handles). `globalConfig.testPathPatterns` is the `TestPathPatterns` object Jest 30 passes. A hook that throws ends the run with Jest's text, class and exit code, and a thrown value that is no Error is printed as pretty-format prints it. Ctrl+C or SIGTERM stops waiting for a hook that hangs, and the second Ctrl+C does not wait for a teardown. `OrchestratorPolicy.globalSetup` gains `teardownOrder` and `failure` (a behaviour, type `GlobalSetupFailure`: `(thrown, { hook, path }) => Error`; Jest's rewrites the thrown error's message in place and keeps its class, `@provino/dialect-jest/global-setup` exports it as `globalSetupFailure` and `@provino/policy` has the neutral one), `NeutralProject` gains `globalSetupArgs` (`GlobalSetupArgs`: the reader's own `globalConfig` and `projectConfig` objects, which never cross to a worker and are not JSON), `@provino/dialect-jest/node` exports `jestRunGlobalHooks`, and each file now sends one `deps` event with the modules it loaded, as `WorkerEvent`'s `{ added, ids }`: a worker names each module path once and sends its number after that.
- 6186141: `--shard=i/n` and the timings file (T9.6). `provino jest --shard` runs the files Jest runs for each shard (Jest's sha1 split, recorded from Jest 30.5.2), and `provino run --shard` splits the path-sorted files by count. With a `provino.timings.json` (`{ "version": 1, "files": { "<path>": <ms> } }`, Bun's shape; `--timings <file>` names another) every dialect cuts contiguous runs of the path-sorted files by predicted time, a file with no time counting as the median. `--update-timings` writes each file that ran, with its time, into the file and keeps every other entry, so shards merge; `provino jest` takes `--update-timings` and `--timings` too. `RunOptions` gains `shard`, `timingsFile` and `updateTimings`; `OrchestratorPolicy.shard.fallback` is now `'sha1-slice' | 'path-slice'` (Jest and Vitest `sha1-slice`, neutral `path-slice`). The results cache's record (`FileHistory`) has room for an inputs hash, a learned tier and a coverage map, and its file version is 3.
  
  Isolation tiers (T2.11). A test file's tier is the project's, raised (never lowered) by its `@provino-isolate <none|registry|realm|process>` docblock pragma or a tier learned from an earlier run; a value that is no tier is a warning. `Loader.tierFor(testFile, sources)` takes `TierSources` and returns a `TierChoice` (the old three-argument form is gone), `WorkerKey` gains `isolation`, and a `process`-tier file runs in a worker of its own.
  
  The `provino` bin turns on Node's compile cache in `node_modules/.cache/provino/compile` (workers inherit `NODE_COMPILE_CACHE`), except under coverage.

### Patch Changes

- dbe800f: Three policy keys for the last Jest 30.5.2 differences, with nothing reading them yet: `ModulePolicy.reevaluatePatchingExternals` (a shared package that replaces a watched global or builtin export is evaluated per file; Jest `true`, neutral and Vitest `false`), `ExpectPolicy.outsideTestCounts` (`'drop'` or `'next-test'`: where the assertion counters made outside a test go; Jest `'next-test'`, neutral and Vitest `'drop'`), and `CorePolicy.boundaryTurns` gains `skippedTest`, `suiteStart`, `suiteEnd`, `runStart`, `retry`, `retryEnd` (an attempt that ends inside jest-circus's retry loop) and `retryExit`, with Jest's recorded values (`runtime/microtask-turns-*`). `LifecycleListener` and `EnvironmentInstance.onTestEvent` may return any thenable, not only a `Promise`. `ImportFile` takes an optional second argument, `evaluated`, which a loader calls as the test file's own evaluation ends; `FileRegistry.import` takes it as a third.
- c5230cd: A matched test file that declares no tests fails, as it does in Jest 30.5.2 and Vitest 5.0.5. Under `provino jest`, a helper under `__tests__`, or a file of one empty `describe`, is a `FAIL` line with "Your test suite must contain at least one test.", counts as a failed suite, ends the run with exit code 1 (also under `--passWithNoTests`, which is about finding no files), and is `failed` with that message in `--json`, where Provino reported it as passed. A file whose tests are all skipped or todo, or that `-t` left no test of, declared some, so it is unchanged. Jest's rule is that a file which loaded and has no test result reads that way whatever errors it holds (an error circus files for a hook in a `describe` with no test, a timer that throws), where a file that threw while loading, or whose environment's teardown threw after it ran (Jest's `runTest` rejects then), keeps its own error, and a file that leaks (`--detectLeaks`) and has no test still reads that way, as Jest checks the results' length before the leaks. A file the worker's runner failed this way is `fail` whatever it declared, and the unhandled error it is charged with has the new origin `runner` (`UnhandledErrorOrigin`). The neutral policy and the Vitest dialect fail such a file too, unless `--passWithNoTests` is given, which is Vitest's rule; they passed it before. The `orchestrator` policy slice gains `noTestsFile: 'fail' | 'fail-unless-pass-with-no-tests' | 'pass'` (Jest `fail`; neutral `fail-unless-pass-with-no-tests`; the Vitest dialect the same, read from its source and not yet recorded), and `file-collect-end` gains `loadFailed`, set on a file that never loaded.
- 9a55f65: Each test file gets its own `process`, as Jest gives it: a copy of the worker's with listeners of its own and a copy of `env`, so an `exit`, `uncaughtException` or `SIGINT` listener a file (or its setup file) adds never reaches the next file in the worker and never runs at the worker's exit, a setup file that adds an `exit` listener per file no longer prints `MaxListenersExceededWarning`, and a file's `process.env` changes stay in the file. The `orchestrator` policy slice gains `processObject` (`'per-file' | 'shared'`: Jest and neutral `per-file`, Vitest `shared`), and `EnvironmentSetupContext` gains `processObject`, which `nodeEnvironment`, `jsdomEnvironment` and the Jest environment adapter read.
- Updated dependencies [063753f]
- Updated dependencies [dbe800f]
- Updated dependencies [e79a080]
- Updated dependencies [f6e0ab6]
- Updated dependencies [73dbb1b]
- Updated dependencies [983f094]
- Updated dependencies [0b12a9f]
- Updated dependencies [7c3711a]
- Updated dependencies [4feaef4]
- Updated dependencies [a9571da]
- Updated dependencies [26ed357]
- Updated dependencies [26ed357]
- Updated dependencies [ddb10bf]
- Updated dependencies [646c3e3]
- Updated dependencies [646c3e3]
- Updated dependencies [475232b]
- Updated dependencies [5ec4d3b]
- Updated dependencies [209f097]
- Updated dependencies [3872fb2]
- Updated dependencies [14850e9]
- Updated dependencies [c5230cd]
- Updated dependencies [493ebff]
- Updated dependencies [929e910]
- Updated dependencies [09fc2b2]
- Updated dependencies [a43cb01]
- Updated dependencies [f7a629d]
- Updated dependencies [f7a629d]
- Updated dependencies [a602762]
- Updated dependencies [dd8b08f]
- Updated dependencies [cffb867]
- Updated dependencies [9a55f65]
- Updated dependencies [2da1a4b]
- Updated dependencies [d464f91]
- Updated dependencies [133727f]
- Updated dependencies [a56ca80]
- Updated dependencies [3872fb2]
- Updated dependencies [6186141]
- Updated dependencies [fe9ad4f]
- Updated dependencies [a2764b2]
- Updated dependencies [1f0842e]
- Updated dependencies [3a87631]
- Updated dependencies [d3d0649]
- Updated dependencies [26ed357]
- Updated dependencies [4f255d8]
- Updated dependencies [a21fdff]
  - @provino/types@0.1.0-rc.0
  - @provino/policy@0.1.0-rc.0
