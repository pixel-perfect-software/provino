# @provino/dialect-vitest

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
