# @provino/dialect-jest

## 0.1.0-rc.7

### Minor Changes

- e3cac0e: The dialects are add-on installs. `provino` no longer bundles `@provino/dialect-jest` or `@provino/dialect-vitest`, nor their Jest, Babel and Chai packages: install `@provino/dialect-jest` beside `provino`, at `provino`'s own version, to run `provino jest` (`pnpm add -D @provino/dialect-jest@<the provino version>`), and `@provino/dialect-vitest` for `provino vitest`. Without the add-on, or with one of another version, the command prints that install line, the version filled in, and exits 1 (`PROVINO_DIALECT_NOT_INSTALLED`, `PROVINO_DIALECT_VERSION_MISMATCH`); an add-on that runs on another copy of `provino` than the one running (a global install, `pnpm dlx`) is refused the same way, naming both (`PROVINO_DIALECT_OTHER_PROVINO`). The add-on is resolved from the project's own install, from the config's directory. `ConfigError` gains `subject`: the dialect or top-level key it refused. Each dialect names `provino` as a peer and runs on its engine through `provino/internal/*` subpaths, which are internal and promise no semver. A project that uses only `provino.config` installs nothing from Jest or Vitest.

### Patch Changes

- c2e1bb1: `defineConfig({ dialect: 'jest' })` and `'vitest'` now type-check against the published packages. The dialects register their name on `DialectRegistry` by declaration merging, and the built declarations named `@provino/types`, which no install has, so `DialectName` was `never`. They now name `provino/config`, which exports `DialectRegistry`, `PluginRegistry` and `ProvidedContext` (augment those there). `provino`'s internal declarations no longer hold a second copy of the three.
- ce31acb: Error and help messages no longer name internal task ids. A non-empty `plugins` or `alsoServe` says `config key "plugins" isn't supported yet`; `provino --help` no longer says that a build loads the Jest dialect's code or points at the task that builds a refused flag; and the "not implemented yet", "not supported yet" and "not applied" texts of `provino run`, `provino jest` and `provino vitest`, the loader, the environments, core, the orchestrator, coverage, the transform and the inline snapshot matchers drop their task and decision references.
- 7b73d24: Fake timers no longer make a test or its hook "time out" at once. After `timers.setSystemTime(date)` and `timers.clearAllTimers()`, the fake `performance.now()` sat years from the real one, and the runtime read it for its own deadlines. A test (a past date) or its `afterEach` (a future one) ended "Test timed out" or "Hook timed out in 10000ms" without waiting, and an async test could get a 1 ms deadline or none. The runtime now reads the clock it captured before any test code ran, as it does for its timers. Under the Jest dialect, a custom environment's `handleTestEvent` no longer hears a negative `test.duration` after `jest.setSystemTime`: `startedAt` and `duration` read the real `Date.now`, as jest-circus's do.
- 55de21e: The policy has three new keys for the Vitest dialect: `snapshot.mismatch` (when a snapshot mismatch fails the test), `core.definitions.extendApi` (whether `test.extend` is there) and `core.definitions.messages` (the module that words a definition error). `WorkerKey` gains an optional `dialect`, and `NeutralProject` gains `importMetaEnv`. The neutral policy and the Jest dialect behave as before: a mismatch fails at the end of the test, and the Jest dialect has no `test.extend`.
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

- @provino/core@0.1.0-rc.6
  - @provino/env-shared@0.1.0-rc.6
  - @provino/expect@0.1.0-rc.6
  - @provino/mock@0.1.0-rc.6
  - @provino/policy@0.1.0-rc.6
  - @provino/resolver@0.1.0-rc.6
  - @provino/timers@0.1.0-rc.6
  - @provino/types@0.1.0-rc.6

## 0.1.0-rc.5

### Patch Changes

- Updated dependencies [fb1e2ad]
  - @provino/timers@0.1.0-rc.5
  - @provino/core@0.1.0-rc.5
  - @provino/env-shared@0.1.0-rc.5
  - @provino/expect@0.1.0-rc.5
  - @provino/mock@0.1.0-rc.5
  - @provino/policy@0.1.0-rc.5
  - @provino/resolver@0.1.0-rc.5
  - @provino/types@0.1.0-rc.5

## 0.1.0-rc.4

### Patch Changes

- @provino/core@0.1.0-rc.4
  - @provino/env-shared@0.1.0-rc.4
  - @provino/expect@0.1.0-rc.4
  - @provino/mock@0.1.0-rc.4
  - @provino/policy@0.1.0-rc.4
  - @provino/resolver@0.1.0-rc.4
  - @provino/timers@0.1.0-rc.4
  - @provino/types@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- @provino/core@0.1.0-rc.3
  - @provino/env-shared@0.1.0-rc.3
  - @provino/expect@0.1.0-rc.3
  - @provino/mock@0.1.0-rc.3
  - @provino/policy@0.1.0-rc.3
  - @provino/resolver@0.1.0-rc.3
  - @provino/timers@0.1.0-rc.3
  - @provino/types@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- d015c8e: A test or hook that times out prints Jest's own text under `provino jest` (`CorePolicy.timeouts.message`, `FormatTimeout`, `formatTimeout`), and a worker that dies of a signal sent to the whole process group is part of the cancellation, not an error of the run.
- Updated dependencies [d015c8e]
  - @provino/types@0.1.0-rc.2
  - @provino/core@0.1.0-rc.2
  - @provino/env-shared@0.1.0-rc.2
  - @provino/expect@0.1.0-rc.2
  - @provino/mock@0.1.0-rc.2
  - @provino/policy@0.1.0-rc.2
  - @provino/resolver@0.1.0-rc.2
  - @provino/timers@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- @provino/core@0.1.0-rc.1
  - @provino/env-shared@0.1.0-rc.1
  - @provino/expect@0.1.0-rc.1
  - @provino/mock@0.1.0-rc.1
  - @provino/policy@0.1.0-rc.1
  - @provino/resolver@0.1.0-rc.1
  - @provino/timers@0.1.0-rc.1
  - @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Minor Changes

- 73dbb1b: `provino jest` runs the changed-file flags: `-o`/`--onlyChanged`, `--changedSince`, `--lastCommit`, `--changedFilesWithAncestor`, `--findRelatedTests` and `--onlyFailures`/`-f`, which were refused. They select the files Jest 30.5.2 selects (git, hg and Sapling, Jest's own commands; the dependency graph by haste's extractor; the failed files from the results history), for a run and for `--listTests`, with Jest's no-tests texts and exit codes. A project's own `dependencyExtractor` is applied, with haste's extractor as its fallback; `DependencyExtractor`'s `fallback` returns a `Set<string>`, as jest-haste-map's does, so an extractor may add to it.
  
  `@provino/dialect-jest/affected` now holds the working provider (`jestChangedFiles`) and extractor (`jestDependencyExtractor`), and `@provino/dialect-jest/node` gains `jestChangedNoTestsMessage`, `jestChangedFilesErrorText` and `JEST_NO_SCM_TEXT`.
- 983f094: Contracts for changed-file and affected-test selection (the groundwork for `--onlyChanged`, `--findRelatedTests` and `--watch` under `provino jest`; nothing selects by them yet). `@provino/types` gains `ChangedFiles`, `ChangedFilesOptions`, `ChangedFilesProvider`, `DependencyExtractor`, `DependencyExtractorFactory` and `AffectedSelection`; `OrchestratorPolicy` gains `changedFiles` and `affected` (`extractor`, `mockEdges`, `invalidateAll`, `graph`); `FileJob` gains `staleModules`; `Loader` gains `dropRecords`; `NeutralProject` gains `watch` and `affected`. `@provino/dialect-jest` adds the `@provino/dialect-jest/affected` entry, whose `jestChangedFiles` and `jestDependencyExtractor` throw `ORCH_NOT_IMPLEMENTED` until they are built.
- 7c3711a: `provino jest` resolves the imports of a test file Jest runs as CommonJS with Jest's CommonJS conditions, as jest-runtime does: an `import` that the project's transform would turn into `require` takes a dual package's `require` entry, not its `import` one, in the test file and in every module it loads. A file Jest runs as an ES module (`.mjs`, a `"type": "module"` package's `.js`, or an extension in `extensionsToTreatAsEsm`, with Node's `--experimental-vm-modules`) keeps the `import` entry. `@testing-library/jest-dom/jest-globals` now loads its CommonJS build beside `@jest/globals`. A package with only an `import` entry is not found from a file Jest runs as CommonJS, as in Jest, so a virtual `jest.mock` of it serves the import. Other dialects resolve each edge as it is written.
  
  `provino`'s `exports` give every subpath a `default` condition naming its `import` file, so `require('provino')` (and a test file Jest runs as CommonJS that imports it) loads the ES module through Node's `require(esm)`.
  
  A dual package's `module-sync` entry is taken as Jest takes it: by every edge of a file Jest runs as an ES module, and by a file Jest runs as CommonJS only when Node evaluates ES modules synchronously (24.9 and later, under `--experimental-vm-modules`); a `jest.mock` of such a package resolves to the same file.
  
  `@provino/types`: `ModulePolicy.edgeResolveKind`, `ModulePolicy.moduleSyncCondition`, `LoaderOptions.esmExtensions`, `SerializedLoaderConfig.esmExtensions` and `NeutralResolution.esmExtensions`.
- 26ed357: Coverage for `provino jest`. `--coverage`, `--collectCoverage` and the `collectCoverage` key collect coverage and write Jest's reports (`coverageReporters`, `coverageDirectory`, `collectCoverageFrom` with the files no test loaded at zero, `coveragePathIgnorePatterns`, `forceCoverageMatch`), with the text reports on stdout as Jest prints them. Both providers work: `coverageProvider: 'babel'` (Istanbul) and `'v8'`. `coverageThreshold` is checked as Jest checks it, and a miss prints Jest's `Jest: …` lines and exits 1. Workers and shards merge into one report, and `--json`'s results carry `coverageMap`.
  
  `RunSummary.coverage` holds a run's merged coverage, moved back to the sources, and `CoverageSummary.untestedFailures` the files no test loaded whose coverage could not be made. The Jest dialect's `/node` entry adds `jestCoverageFilter`, `jestCoverageOptions` and `jestCoverageTexts`, and `AggregatedResult.coverageMap`.
- 26ed357: Coverage under `provino jest` follows Jest 30.5.2 more closely. With Jest's default babel-jest transform, only the files under the process's working directory are instrumented, as babel-jest's `cwd` does (`cd packages/a && jest` with `rootDir: '../..'`). Every coverage entry carries Istanbul's own `_coverageSchema`, the value Jest writes. A source that is not on disk but whose source map carries its text is shown in the reports from that text. A run without coverage loads none of the coverage code.
  
  `SerializedCoverageConfig.instrumentRoot` is the root Istanbul instruments within when it is not `projectRoot`, `CoverageSummary.sources` holds the text of sources not on disk, and `jestCoverageFilter` takes `{ babelInstruments }`.
- ddb10bf: Coverage groundwork for `provino jest`: `@provino/types` gains `IstanbulFileCoverageData`, `SerializedCoverageConfig`, `RunCoverageOptions`, `CoverageThresholdGroup`, `CompiledModuleInfo`, `CoverageSummary.map`, `SerializedProjectConfig.coverage` and `NeutralProject.coverage`; the `coverage` worker event's `fileId` may be `null`; and the `coverage` policy slice gains `v8Conversion`, `v8HitCounts`, `istanbulVariable` and `thresholdMessages` (Jest's texts and values in `@provino/dialect-jest`). The transform pipeline takes an `instrumenter`. Nothing collects coverage yet.
- 1562aa0: `coverageThreshold` for `provino jest`. A run that collects coverage checks the global, path and glob groups as Jest does (a glob group file by file, negative thresholds as a cap on the uncovered count, a group no file matched as not found), prints Jest's `Jest: ...` lines on stderr after the reports and exits 1 when one is missed, with `success: false` in `--json`. The config key no longer warns that it is read but not applied.
- 646c3e3: `coverageProvider: 'v8'` now counts a CommonJS module as Jest does: the vm script and the wrapper the loader compiles the module in count nowhere but as the module's own function, at any worker count. A file that ends in types has a statement on each of their lines, as Jest's documented `babel-jest` with `@babel/preset-typescript` reports it. The new policy key `coverage.v8Hashbang` (Jest: `removed`) reproduces Jest's offsets for a module that starts with a hashbang. A module's code and map cross from the workers once per run: `WorkerInit.coverageModules` names what the coordinator already holds, and a worker sends those as an `ExecutedModuleRef`.
- 646c3e3: Jest's `v8` coverage provider for `provino jest`. `coverageProvider: 'v8'` collects V8's coverage in each worker and converts it as Jest 30.5's v8 provider does (`v8-to-istanbul`, with `@bcoe/v8-coverage`'s merge of every worker's take), so the reports, `coverage-summary.json` and the text report carry Jest's numbers; a file no test loaded is reported at zero over its whole size, as Jest does. `ExecutedModuleInfo` carries the transformed `code` V8 counted and the `map` back to the source, which the coordinator converts from.
- 475232b: The first built packages: each ships ESM and declarations in `dist`, and its API is reported in `etc/` and checked by `pnpm hygiene`. `provino` gains the `.`, `/globals`, `/config`, `/reporters`, `/environment` and `/jest` entry points beside `/node`, and a `--version` flag.
- 209f097: `provino jest` prints the `github-actions` reporter's result tree with `silent: false` (B23d A4), in the run's own colours. `TextStyle` gains `inverse`, which chalk's `inverse` is, and `provino/reporters`' `createStyle` provides it.
- 3872fb2: `provino jest` runs the project's `globalSetup` and `globalTeardown` in the coordinator, as Jest does: once per distinct path, in the order Jest's sequenced list reaches the projects, then the root config's own hooks (Jest's `globalConfig.globalSetup`, with `projects`), with `(globalConfig, projectConfig)`, through the project's transform (a TypeScript file, or one babel-jest or ts-jest handles). `globalConfig.testPathPatterns` is the `TestPathPatterns` object Jest 30 passes. A hook that throws ends the run with Jest's text, class and exit code, and a thrown value that is no Error is printed as pretty-format prints it. Ctrl+C or SIGTERM stops waiting for a hook that hangs, and the second Ctrl+C does not wait for a teardown. `OrchestratorPolicy.globalSetup` gains `teardownOrder` and `failure` (a behaviour, type `GlobalSetupFailure`: `(thrown, { hook, path }) => Error`; Jest's rewrites the thrown error's message in place and keeps its class, `@provino/dialect-jest/global-setup` exports it as `globalSetupFailure` and `@provino/policy` has the neutral one), `NeutralProject` gains `globalSetupArgs` (`GlobalSetupArgs`: the reader's own `globalConfig` and `projectConfig` objects, which never cross to a worker and are not JSON), `@provino/dialect-jest/node` exports `jestRunGlobalHooks`, and each file now sends one `deps` event with the modules it loaded, as `WorkerEvent`'s `{ added, ids }`: a worker names each module path once and sends its number after that.
- 14850e9: `provino jest` writes inline snapshots as Jest 30.5.2 does: a new one, or one that differs under `-u`, goes into the test file once the file ends, the call reprinted with Babel's generator exactly as jest-snapshot does (Babel is loaded only when a snapshot is written, from the project's install first, then Provino's pinned copy), and the file formatted with the project's Prettier 3 when it has one (Prettier 2 writes unformatted, with a warning). Jest's errors are kept: one call reached twice fails its file, and a file that fails that way counts none of its tests. A project's `snapshotResolver` is applied, loaded through each test file's registry, with Jest's texts for a resolver that lacks a member or doesn't invert itself. After a run, the snapshot files no test file has are reported (and removed under `-u`) in the Snapshot Summary, as Jest's `cleanup` does, through a custom resolver's inverse too. `SnapshotPolicy` gains `inline.writer`, `inline.prettierPath`, `resolverFactory` and `obsoleteFiles`; `SnapshotFileReport` gains `inline` (`InlineSnapshotEdit[]`); `SnapshotMessages` gains the optional `noInlineFrame` (the dialect's own error for an inline snapshot whose call has no frame to write at; Jest's is its plain `Error`); `SnapshotRunSummary` gains `filesRemovedList`; `FileResult` gains `resultsDiscarded`; `SerializedProjectConfig` and `NeutralProject` gain `snapshotResolver`. New types: `InlineSnapshotEdit`, `InlineSnapshotWriter`, `InlineSnapshotWriterFactory`, `InlineSnapshotWriteOptions`, `SnapshotResolver`, `SnapshotResolverFactory`. `@provino/dialect-jest/inline-snapshots` exports `jestInlineSnapshotWriter`, and `@provino/dialect-jest/runtime` exports `jestSnapshotResolver`.
- 493ebff: A custom Jest environment's `handleTestEvent` is called (T8.5): the file's run reports jest-circus's events, in circus's order and with its fields, to the environment (`setup`, the definition events, `run_start`, `run_describe_start`, `test_start`, the hooks, `test_fn_*`, `test_done`, `test_retry`, `describe_retry`, `concurrent_tests_*`, `run_finish`, `teardown`), awaited as circus awaits them. `@provino/types` gains `LifecycleEvent`, `LifecycleHookKind`, `LifecycleHookRef`, `LifecycleListener`, `LifecycleMode` and `LifecycleRef`, and `EnvironmentInstance.onTestEvent` now takes a `LifecycleEvent`; a run whose environment has no handler pays nothing. The `jest-environment` adapter passes the environment class Jest's `globalConfig`.
- 929e910: `provino jest` runs in band as Jest does, and takes `--filter`, `--projects` and `--debug` (T9.9). `-i`, one file, one worker, or up to 20 files that ran under a second last time (and no `workerIdleMemoryLimit`) run the files in the bin's own process, with a test's `console` still buffered per file, so a test sees what the global setup put on `globalThis`. The `orchestrator` policy slice's `runInBand: { auto }` becomes `inBand: { single, fastFileCount, slowMs }` (Jest `{ true, 20, 1000 }`; Vitest and neutral `{ false, 0, 0 }`), and `WorkerInit` gains `captureConsole`. `--filter` loads a module that returns `{ filtered }` per project (with Jest's `setup`, `--skipFilter` and its errors), `--projects` reads the configs of the paths it lists, and `--debug` prints `{ configs, globalConfig, version }` before the run. `@provino/dialect-jest/node` gains `loadJestFilter` and `jestDebugText`. `RunInfo` gains `inBand`, which `createJestReporterHost` reads for `showStatus` when it is given none. A file's path in `provino jest`'s output is relative to the working directory, as in Jest, also when the config's `rootDir` is another directory. `provino run --detectOpenHandles` (in band) now captures a test's `console` and hands it to the reporters, where it used to go straight to stdout.
- 09fc2b2: `provino jest --json` writes Jest's results: `--json` prints them on stdout (or to `--outputFile`, saying `Test results written to: <path>`), `--useStderr` sends the rest of the output to stderr, `--testLocationInResults` adds each test's `location`, and a `testResultsProcessor` receives Jest's `AggregatedResult` and its return value is what is written and decides the exit code. `@provino/dialect-jest` gains the `./results` entry (Jest 30.5's result shapes and the collector that builds them from a run's events), and `@provino/types` gains `SerializedError.details`, `FileResult.snapshot` and `FileInfo.projectIndex`.
  
  `provino jest --collectTests` discovers and reports every test without running a hook or a body: the tree on stdout, or Jest's JSON with `--json` (each test `passed` with `wouldRun`, `pending` or `todo`), and `No tests found.` when nothing matches. `@provino/types` gains `FileJob.collectOnly`; `@provino/dialect-jest/node` gains `jestCollectedText`.
- a43cb01: `provino jest --randomize` and `--seed` (T5.13): each file's suites are shuffled with jest-circus's own generator (pure-rand's xoroshiro128+ and Fisher-Yates), so a seed gives the order Jest gives, and the results and the verbose list show the tests in that order. The `core` slice gains `shuffle` (`ShuffleFactory`; `null` cannot shuffle, Jest's is `jestShuffle` from `@provino/dialect-jest/runtime`), `SerializedProjectConfig` and `NeutralProject` gain `randomize`, and `TaskResult` and `FileResult` gain `childOrder`, the order a shuffled suite ran its children in.
  
  `jest.retryTimes(n, { entireDescribe: true })` (T5.10): a describe block, or the whole file when called at its top level, runs again, hooks and every test below, while a test in it fails; the last attempt stands, with the dropped attempts' errors kept under `logErrorsBeforeRetry`. `GlobalsHost` gains `setDescribeRetry`, and `DescribeRetry` and `DescribeRetryResult` are exported.
  
  A dropped describe attempt is reported as Jest reports it: each test in it has a `test-attempt-end` with `willRetry: true`, which now carries the attempt's own `assertions` and `passingAssertions` (`RuntimeEvent`), so a Jest reporter's `onTestCaseResult` hears every attempt with its status and passing assertions, and the result of the attempt that stood carries that attempt's counts. Blocks that run side by side keep their attempts apart, an error a test had before the attempt (a parent `beforeAll`'s) no longer retries the block, an error charged late to an ended test retries it as jest-circus does, and a fractional `--seed` is taken as Jest takes it.
- f7a629d: `provino jest` runs Jest reporters: `--reporters` and the `reporters` config key take `default`, `agent`, `summary` (with `summaryThreshold`), `github-actions` and any module that exports a Jest reporter class, which is constructed and called as Jest calls it (`onRunStart`, `onTestFileStart`, `onTestCaseStart`, `onTestCaseResult`, `onTestFileResult`, `onRunComplete`, `getLastError`). A failed file prints Jest's own failure text and code frame, with Provino's frames hidden, and a console call under Jest keeps its call site (`at Object.log (file.test.ts:4:11)`). `provino run --reporter summary` prints the totals alone. `@provino/types` gains `TextStyle` and the policy key `orchestrator.consoleOrigin` (`stack` for Jest); `@provino/dialect-jest/node` gains `jestReporterPlan`, `loadJestReporters` and `createJestReporterHost`.
- f7a629d: `provino jest` prints Jest's closing line (`Ran all test suites ...`), the Snapshot Summary and the per-file snapshot lines. The text reporters take a `fileNotes` option.
- f7a629d: `provino jest` runs the third-party reporters real projects name (jest-junit, jest-silent-reporter, jest-html-reporters, vscode-jest's reporter, `testResultsProcessor: jest-sonar-reporter`) with Jest's text on 20 files. Jest's own `github-actions` reporter is the one `provino jest` runs, a console entry's call site renders through `jest-message-util` (a code frame for `warn` and `error`), `failureDetails[i]` has the `message`, `stack` and `name` a reporter reads, and a failing frame is named as Jest names it (`at Object.toBe`): `ModulePolicy.stackFrameNames`, and `jestConsoleTrace` in `@provino/dialect-jest/node`. The text reporters take a `consoleTrace` option.
- 2b12e4a: `provino jest --watch` gains Jest 30.5.2's `u` key (a run that updates the failing snapshots), the `i` key's interactive failed-test and snapshot modes, and third-party `watchPlugins` (jest-watch-typeahead among them), which were refused: each plugin is loaded and built as Jest builds it, hears `onFileChange`, `shouldRunTestSuite` and `onTestRunComplete`, and a plugin that fails to load or takes a key another plugin or Jest holds ends watch mode before any run with Jest's text and exit 1.
  
  `@provino/dialect-jest/node` gains the two interactive modes, the plugin host (`loadJestWatchPlugin`, `checkJestWatchPluginConflicts`, `JestWatchPluginError`), and `JestWatchHost.listTests` and `cwd`; `jestUpdateSnapshotsPlugin` takes no argument.
- a602762: `provino jest --watch` and `--watchAll` run Jest 30.5.2's watch mode, which was refused: the first run at once, a run after each change on one warm pool, and the keys `a`, `f`, `o`, `p`, `t`, `q`, `w`, `c`, Enter, Esc, Ctrl+C and Ctrl+D with Jest's usage text, pattern prompts and closing lines. `--watch` outside a repository says so and exits 1, as Jest does. A change saved while a run is going starts one more run when it ends (Jest drops it). The `u` and `i` keys, third-party `watchPlugins`, and `--coverage`, `--collectTests` and `--detectOpenHandles` in watch mode are not built yet, and say so.
  
  `@provino/dialect-jest/node` gains the watch driver (`startJestWatch` over a `JestWatchHost`) and its parts, and `OrchestratorPolicy.watch` gains `interruptedFiles` (`report`, or Jest's `drop`: what an interrupted watch run reports of the files it killed).
- 7f05c04: The `provino` reporter, Provino's own live output, is what an interactive terminal gets when no reporter is named, under `provino run` and `provino jest`: a terminal that is not CI, not an agent's and not `TERM=dumb`, outside watch mode and without `--verbose`. Pipes, CI, agents, editors, watch mode, `--verbose` and any named reporter keep Jest's text. `ReporterChoice` gains `'provino'` and `['provino', { tree?, map? }]` (the views come later) and the reserved `'html'` and `['html', { outputFile? }]` (a usage error until the HTML report is built). `RunOptions.emoji: false` and `--no-emoji` (also taken by `provino jest`, before Jest's parser) give plain symbols. The reporter's code is its own chunk of the bundle, loaded only when it is chosen. The cursor it hides is shown again on `exit`, so a `process.exit` (`--forceExit`, a second signal) leaves the terminal as it was.
  
  `@provino/dialect-jest`: the config reader takes `hostReporters` (`NormalizeOptions`), names it keeps bare in `reporters` and `--reporters` instead of resolving them as modules, and `jestReporterPlan` takes them as `{ hostReporters }` and plans each as a `host` step (`JestReporterStep`). A path such as `./provino` is still a module.
  
  `@provino/reporters`: the `provino` reporter keeps a file's counts when the next file starts on the same worker before it has ended, as a run in band does.
  
  The `provino` reporter's own layout carries what the flags ask for: the seed (`--showSeed`, `--randomize`) and every snapshot outcome (failed, written, updated, obsolete, obsolete or removed files) in the end card, with the command that updates them, each file's snapshot outcome under its line, and its heap after its time (`--logHeapUsage`). One rule chooses it under both commands, Jest's single-file rule included: a run of one file that rule lists keeps the listing. While it draws, the process's own writes to a terminal stdout or stderr (`--pool inline`, in band) go above the footer; its terminal is put back on a throw, before a global-setup failure is printed, and on a signal nothing else handles, which is then raised again.
- d464f91: `provino jest` evaluates a package in `node_modules` again in each test file when, as it first loads in a worker, it reads a per-file global: a test hook, `jest` or `expect`, or a global the environment installed (`document`, `window`, …), as Jest evaluates node_modules per file. React Testing Library's `afterEach(cleanup)` and `screen`, `@testing-library/jest-dom`'s `expect.extend`, jest-canvas-mock, jest-styled-components, jest-extended and jest-fetch-mock now work in every file of a worker, not only the first. What a worker learns is kept in the results cache, so the next run evaluates those packages per file from its first file. A package whose own code requires `@jest/globals` (jest-mock-extended) gets Provino's module, not the real one that refuses to load. Other dialects keep one evaluation per worker.
  
  `@provino/types`: `ModulePolicy.reevaluateHookingExternals`, `Loader.watchExternalLoads`, `takeLearnedExternals` and `reevaluateExternals`, `ExternalLoadWatcher`, `SerializedLoaderConfig.reevaluate` and `fileDone.reevaluated`; `EnvironmentInstance.globalReads` and `GlobalReadWatch` (an environment's populated accessors report reads, so the worker's watch redefines none of them); `SerializedError.enumerableFields` (which of `name`, `message` and `stack` the thrown value had as its own enumerable fields, for `--json`'s `failureDetails`).
- a56ca80: `provino jest` applies `--showSeed`, `--logHeapUsage`, `--notify`, `--notifyMode` and `--detectLeaks` (and the config keys of the same names; `detectLeaks` is a project key, as in Jest); none is refused or warned about any more. The summary has a `Seed:` line before `Test Suites:` when the seed is shown (`--randomize` shows it too), a file's header ends ` (<n> MB heap size)` under `--logHeapUsage`, and `--notify` calls `node-notifier` as Jest's `NotifyReporter` does, found in the project and then in its `@jest/reporters` install (Provino has no dependency on it; without it the run ends with Jest's message and exit 1). `--detectLeaks` checks, after each file's teardown, that nothing still reaches its registry or environment, and fails a file that is held with Jest's text; a project that asks for it under isolation `none` is refused with `ORCH_BAD_OPTION`.
  
  `FileJob` gains `detectLeaks` and `logHeapUsage`, `FileResult` gains `leaks` and `heapUsedBytes`, the worker's `fileDone` gains `leaks` and `heapUsedBytes`, `FileRegistry` gains the optional `leakTargets()`, and the dialect exports `createNotifyReporter`, `loadJestNotifier` (which returns `{ notifier, icon }`), `JestNotifierMissingError` and `LEAK_MESSAGE`; `RunProjectOptions.detectLeaks` is a predicate over the projects. The text reporters' options gain `seed`.
- 3872fb2: `jest.retryTimes` runs: a failed test is retried after the rest of its describe (or at once with `retryImmediately`), as Jest does, with `waitBeforeRetry` and `logErrorsBeforeRetry`. `GlobalsHost` gains `setDefaultRetry`, and `@provino/types` the `DefaultRetry` it takes. `entireDescribe` is still refused by name. A test that already failed before it ran (a `beforeAll` error) is never retried, as Jest's. A test's `retry` option is checked when it is registered (`CORE_INVALID_ARGUMENT`), and a `g` or `y` RegExp `condition` is tested from the start each time. `CorePolicy.retry` gains `functionCondition` (`call` or `ignore-warn`) and `functionConditionWarning` (the text it warns with): Vitest's dialect keeps Vitest's outcome, a function `condition` never called, and warns once a file. `DefaultRetry` is `{ count, delay, timing?, keepEarlierErrors? }`, in the policy's words: a key it leaves out is the policy's (`retry.timing`, `retry.keepEarlierErrors`).
- 6186141: `--shard=i/n` and the timings file (T9.6). `provino jest --shard` runs the files Jest runs for each shard (Jest's sha1 split, recorded from Jest 30.5.2), and `provino run --shard` splits the path-sorted files by count. With a `provino.timings.json` (`{ "version": 1, "files": { "<path>": <ms> } }`, Bun's shape; `--timings <file>` names another) every dialect cuts contiguous runs of the path-sorted files by predicted time, a file with no time counting as the median. `--update-timings` writes each file that ran, with its time, into the file and keeps every other entry, so shards merge; `provino jest` takes `--update-timings` and `--timings` too. `RunOptions` gains `shard`, `timingsFile` and `updateTimings`; `OrchestratorPolicy.shard.fallback` is now `'sha1-slice' | 'path-slice'` (Jest and Vitest `sha1-slice`, neutral `path-slice`). The results cache's record (`FileHistory`) has room for an inputs hash, a learned tier and a coverage map, and its file version is 3.
  
  Isolation tiers (T2.11). A test file's tier is the project's, raised (never lowered) by its `@provino-isolate <none|registry|realm|process>` docblock pragma or a tier learned from an earlier run; a value that is no tier is a warning. `Loader.tierFor(testFile, sources)` takes `TierSources` and returns a `TierChoice` (the old three-argument form is gone), `WorkerKey` gains `isolation`, and a `process`-tier file runs in a worker of its own.
  
  The `provino` bin turns on Node's compile cache in `node_modules/.cache/provino/compile` (workers inherit `NODE_COMPILE_CACHE`), except under coverage.
- fe9ad4f: jest-image-snapshot runs under `provino jest`. Its `toMatchImageSnapshot` finds `this.snapshotState` as jest-snapshot 30.5's `SnapshotState`: the live `_counters` map it shares with `toMatchSnapshot`, `_updateSnapshot`, and the `added`, `matched`, `unmatched` and `updated` counts it writes back, which the totals and the Snapshot Summary now count. New images, matches, mismatches with their diff, `-u`, `--ci` and `jest.retryTimes` give what Jest 30.5.2 gives: `jest.retryTimes(n)` now also leaves jest-runtime's `Symbol.for('RETRY_TIMES')` globals (and the three options beside it) on the file's global, which the matcher reads, and a retry keeps what the matcher wrote, as Jest's does.
  
  The `snapshot` policy slice gains `contextView` (`Behaviour<SnapshotViewFactory> | null`): what a matcher sees as `this.snapshotState`. `null` (the neutral and Vitest value) is the file's state itself; the Jest dialect's is `@provino/dialect-jest/runtime`'s `jestSnapshotStateView` (with its `JestSnapshotStateView` type). `@provino/types` adds `SnapshotViewSource` (what a view is built over) and `SnapshotViewFactory`.
- a2764b2: A custom matcher that calls jest-snapshot's own matchers with its `this`, as Jest documents (`toMatchSnapshot.call(this, received, hint)`, `toMatchInlineSnapshot`, `toThrowErrorMatchingSnapshot`), runs under `provino jest`. `this.snapshotState` now carries every public member of jest-snapshot 30.5's `SnapshotState` a matcher can use: `match` (Jest's arguments and result), `fail`, `expand`, `snapshotFormat`, `snapshotPath`, `markSnapshotsAsCheckedForTest`, `getUncheckedCount` and `getUncheckedKeys`, beside the fields jest-image-snapshot reads. Before, such a matcher threw `TypeError: snapshotState.match is not a function`. An inline snapshot it takes is written at the custom matcher's call. `@provino/types` adds `SnapshotViewMatchOptions` and `SnapshotViewMatchResult`, and `SnapshotViewSource` gains the members the view is built over; `@provino/dialect-jest/runtime` adds `JestSnapshotMatchOptions`; its `match` returns `SnapshotViewMatchResult`. A snapshot taken through `match` or `fail` belongs to the running test attempt, so `jest.retryTimes` takes it back with the attempt, as Jest does.

### Patch Changes

- dbe800f: Three policy keys for the last Jest 30.5.2 differences, with nothing reading them yet: `ModulePolicy.reevaluatePatchingExternals` (a shared package that replaces a watched global or builtin export is evaluated per file; Jest `true`, neutral and Vitest `false`), `ExpectPolicy.outsideTestCounts` (`'drop'` or `'next-test'`: where the assertion counters made outside a test go; Jest `'next-test'`, neutral and Vitest `'drop'`), and `CorePolicy.boundaryTurns` gains `skippedTest`, `suiteStart`, `suiteEnd`, `runStart`, `retry`, `retryEnd` (an attempt that ends inside jest-circus's retry loop) and `retryExit`, with Jest's recorded values (`runtime/microtask-turns-*`). `LifecycleListener` and `EnvironmentInstance.onTestEvent` may return any thenable, not only a `Promise`. `ImportFile` takes an optional second argument, `evaluated`, which a loader calls as the test file's own evaluation ends; `FileRegistry.import` takes it as a third.
- 0b12a9f: `provino jest` gives a promise chain a test leaves running as many microtask turns before the next hook or test as Jest 30.5.2 does: 20 from a test's end to its `afterEach`, 21 between hooks, 67 from the last `afterEach` to the next test's `beforeEach`, 66 between tests with no hooks. jest-circus awaits its six event handlers at every event it dispatches; Provino's own code took 2 turns, so an axios interceptor chain reached its mock adapter after `afterEach` had reset it, and a react-hook-form update landed outside `act()`. `CorePolicy.boundaryTurns` (`BoundaryTurns`) holds each boundary's turns; the neutral and Vitest values are all 0.
- e1ac91d: `provino jest --projects a b` (or a config's `projects`) no longer fails with Node's `ERR_INTERNAL_ASSERTION` when the projects share a CommonJS custom `resolver`, such as `ts-jest-resolver`. The Jest dialect loads what a Jest config names as jest-util's `requireOrImportModule` does: a plain `require` (an `import()` for `.mjs`/`.mts`, or when `require` refuses an ES module), so a config, reporter, watch plugin or results processor loads once per process, and a custom resolver is loaded once per process by its real path and shared by every project, as jest-resolve's `preloadedResolvers` is. A preset is still read afresh for each project, as Jest deletes it from `require.cache` first. Before, each project imported the resolver afresh at the same time, and a second fresh load of a CommonJS file removed its entry from Node's module cache while Node was still loading the first.
  
  A resolver that throws as it loads is `JEST_CONFIG_RESOLVER_LOAD_FAILED`, with a message that names the resolver and the first line of what it threw, and what it threw as the `cause`, and `provino jest` prints that error's stack, as jest-cli does. `@provino/config` no longer exports `importConfigModule` (only `loadConfigFile` called it, and its `withoutDefault` option, which served Jest's resolver, is gone): the `provino.config.*` loader runs fresh loads of one file (by its real path) one after another, so two runs that overlap on one config can't meet the same assertion.
- c5230cd: A matched test file that declares no tests fails, as it does in Jest 30.5.2 and Vitest 5.0.5. Under `provino jest`, a helper under `__tests__`, or a file of one empty `describe`, is a `FAIL` line with "Your test suite must contain at least one test.", counts as a failed suite, ends the run with exit code 1 (also under `--passWithNoTests`, which is about finding no files), and is `failed` with that message in `--json`, where Provino reported it as passed. A file whose tests are all skipped or todo, or that `-t` left no test of, declared some, so it is unchanged. Jest's rule is that a file which loaded and has no test result reads that way whatever errors it holds (an error circus files for a hook in a `describe` with no test, a timer that throws), where a file that threw while loading, or whose environment's teardown threw after it ran (Jest's `runTest` rejects then), keeps its own error, and a file that leaks (`--detectLeaks`) and has no test still reads that way, as Jest checks the results' length before the leaks. A file the worker's runner failed this way is `fail` whatever it declared, and the unhandled error it is charged with has the new origin `runner` (`UnhandledErrorOrigin`). The neutral policy and the Vitest dialect fail such a file too, unless `--passWithNoTests` is given, which is Vitest's rule; they passed it before. The `orchestrator` policy slice gains `noTestsFile: 'fail' | 'fail-unless-pass-with-no-tests' | 'pass'` (Jest `fail`; neutral `fail-unless-pass-with-no-tests`; the Vitest dialect the same, read from its source and not yet recorded), and `file-collect-end` gains `loadFailed`, set on a file that never loaded.
- f7a629d: Fixes from the pre-merge review of the reporter host: an install's `node_modules/provino` frames and a percent-encoded checkout path are hidden from Jest's failure text; a console `warn` or `error` keeps its whole stack (a code frame and every frame outside Provino) and a `prepareStackTrace` that returns no string no longer throws in the test's call; `getLastError()` fails the run for any truthy value (`JestReporterInstance.getLastError` returns `unknown`); `onRunComplete` hears `success: false` as Jest's does; `showStatus` follows Jest's in-band rule; `default` is verbose only when a project that runs is; `summaryThreshold: null` is Jest's default; an error a reporter throws is printed when no text reporter shows it; `Test run was interrupted.` is printed in watch mode only; the `github-actions` option `silent: false` is refused by name.
- cffb867: `provino jest` prints a failed `node:assert` call as Jest 30.5.2 does. A test that fails with `assert.equal`, `strictEqual`, `deepStrictEqual`, `ok`, `notEqual`, `throws`, `doesNotThrow`, `match`, `rejects` or `fail` reads `assert.equal(received, expected)`, `Expected value to be equal to:`, the received value and a diff (jest-circus's `formatNodeAssertErrors`), where Provino printed Node's `AssertionError [ERR_ASSERTION]: …`; `failureMessages` and `failureDetails` in `--json` follow. The policy gains `core.shapeTestError` (`ShapeTestError`), a behaviour `(error, { expand })` that replaces each error attached to a test's result before it is reported (`--expand` reaches the diff of a failed `node:assert` call as it does Jest's); the Jest dialect sets it, the neutral policy leaves it `null`.
- 9a55f65: Each test file gets its own `process`, as Jest gives it: a copy of the worker's with listeners of its own and a copy of `env`, so an `exit`, `uncaughtException` or `SIGINT` listener a file (or its setup file) adds never reaches the next file in the worker and never runs at the worker's exit, a setup file that adds an `exit` listener per file no longer prints `MaxListenersExceededWarning`, and a file's `process.env` changes stay in the file. The `orchestrator` policy slice gains `processObject` (`'per-file' | 'shared'`: Jest and neutral `per-file`, Vitest `shared`), and `EnvironmentSetupContext` gains `processObject`, which `nodeEnvironment`, `jsdomEnvironment` and the Jest environment adapter read.
- 2da1a4b: `provino jest` hands a rejection Node reports after a test file's run to the process's own listeners, as Jest 30.5.2 does: jest-circus puts its error listeners on the process only while a file runs and takes the process's own off for it, so a promise chain a test leaves in a file that waits for no timer is reported after the run and goes to a listener such as the one Next.js's transformer installs, and no test fails. With no listener of the process's own, Provino still fails the test that left it (where Jest's process would die). `CorePolicy.errors.processListeners` (`alongside` neutral and Vitest, `per-file` Jest) places the listeners. Jest's `waitForUnhandledRejections` option is applied (`CorePolicy.errors.waitForUnhandledRejections`).
  
  A package Provino loads natively for a test file now loads with Node's CommonJS loader as Provino found it, so a patch code outside the test files made to it (Next.js's require hook, which next/jest's config and transformer install) no longer reaches the package's own `require`s, as jest-runtime never calls Node's loader: a jsdom file of a Next.js app no longer fails at load with `ReferenceError: Request is not defined` when the cache is empty. `ModulePolicy.nativeLoadPatches` (`apply` neutral and Vitest, `skip` Jest).
- 3a87631: `provino jest` transforms a package under `node_modules` that `transformIgnorePatterns` let through, as Jest does, when Node can't load it natively: ES module syntax, a TypeScript or JSX extension, an asset extension such as `.css` (the claiming transform runs on it, as in Jest), or a CommonJS file Node fails to parse (JSX or Flow in a React Native package). `next/jest`'s `transpilePackages`, patterns that ignore no package, and React Native's preset now work. Such a file is transformed (by the project's transformer, or by Provino's own in place of the default `babel-jest`) and loaded per test file, and a CommonJS package that requires one is loaded per test file too, so both see one copy. Any other CommonJS package the patterns let through is still loaded by Node, once per worker. Under Jest's default patterns an ES module package that Node can't load fails with Jest's `Must use import to load ES Module` text in place of Node's `ERR_MODULE_NOT_FOUND`, under Jest's conditions (not for a `.cjs` file or a `"type": "commonjs"` package, and not where Node evaluates ES modules synchronously). `transformIgnorePatterns` that are not regular expressions, alone or joined with `|`, are a config error even with no transform.
  
  `@provino/types`: `TransformClaims`, `LoaderOptions.transformClaims`, `SerializedLoaderConfig.transformClaims` and `NeutralProject.standInTransformPatterns`.
- a7d9dda: Unhandled errors raised while a test runs, or between tests, now fail the file, as in Jest. `RunEnd` gains the optional `unownedError`.
- 4935658: Watch mode loads only under `--watch` and `--watchAll`. The watch driver, Jest's watch loop, the file watcher and the watch session are one chunk of the `provino` bundle that the bin imports when one of those flags is given, so no other run reads them. `JestWatchPluginError` moved to its own module in the dialect; its export is unchanged.
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
- Updated dependencies [e33f3ad]
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
  - @provino/core@0.1.0-rc.0
  - @provino/env-shared@0.1.0-rc.0
  - @provino/expect@0.1.0-rc.0
  - @provino/mock@0.1.0-rc.0
  - @provino/resolver@0.1.0-rc.0
  - @provino/timers@0.1.0-rc.0
