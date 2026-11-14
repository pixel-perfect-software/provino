# Jest compatibility

What `provino jest` does and doesn't do today. Provino matches the behaviour of Jest 30.5.

## What works

Provino's tests compare almost everything here with Jest 30.5, either against recordings of the real runner or with Jest running beside Provino on the same project. The one exception is `--showConfig`, which prints Provino's own reading of the config and isn't compared with Jest's output.

**The command line and config**
- Jest's own flags and config keys, including any config key given as a flag (`--testMatch`, `--roots`, `--testTimeout`, …), and Jest's exit codes. A flag Provino can't run yet is refused by name, never ignored without saying so.
- A config with several `projects`, run in one pool, and the `--projects` flag. `--selectProjects` and `--ignoreProjects` work.
- `--filter` (a module that returns `{ filtered }`, with its `setup`, and `--skipFilter`) and `--debug`.
- Running in band as Jest does: `-i`, one file, one worker, or up to 20 files that ran under a second last time (and no `workerIdleMemoryLimit`) run in Provino's own process, so a test sees a global that `globalSetup` set.
- Test path patterns, `--runTestsByPath`, `-t`, `-u`/`--updateSnapshot`, `-w`/`-i`, `--ci`, `--passWithNoTests`, `--no-cache`, `--listTests [--json]`, `--showConfig` and `--clearCache`.
- `--json`, `--outputFile`, `--useStderr`, `--testLocationInResults` and `testResultsProcessor`: the results file has Jest's keys and values, and the processor gets and returns Jest's object. `--collectTests` imports each file, runs no test and prints Jest's tree or JSON.
- `--bail`, `--forceExit`, `--detectOpenHandles`, `workerIdleMemoryLimit`, and `--shard=i/n`. A shard is Jest's split, or a cut by time from a timings file, with Provino's own `--timings` and `--update-timings`.
- Ctrl+C stops the run and exits 130; a second Ctrl+C kills every worker at once. SIGTERM exits 143.
- `globalSetup` and `globalTeardown`, run once per project and path, as Jest runs them.
- Running only what changed: `-o`/`--onlyChanged`, `--changedSince`, `--lastCommit`, `--changedFilesWithAncestor` (git, hg and Sapling, with Jest's own commands), `--findRelatedTests` (the tests whose imports reach the given files, read with Jest's own rules: mocks, `moduleNameMapper`, a project's `dependencyExtractor`), and `--onlyFailures`/`-f` (the files that failed last time), for a run and for `--listTests`, with Jest's no-tests texts and exit codes.
- Coverage: `--coverage` and `--collectCoverage`, and the keys `collectCoverage`, `collectCoverageFrom`, `coverageDirectory`, `coveragePathIgnorePatterns`, `coverageProvider` (`babel` and `v8`), `coverageReporters` (any Istanbul reporter), `coverageThreshold` and `forceCoverageMatch`. Under `babel`, the per-file summary, `coverage-final.json`, lcov, clover and the text reports are checked against Jest's; under `v8` the counts equal Jest's, with the position limits in the gap table below. The HTML report is written but not compared byte for byte. Files no test loaded count at zero, a missed threshold prints Jest's `Jest: …` lines and exits 1, workers and shards merge into one report, and `--json` carries `coverageMap`. A project that uses `babel-jest` is instrumented by its own Babel, every other project by Provino's Istanbul instrumenter.

**Your code**
- TypeScript, TSX, JSX and JavaScript, compiled with Oxc. Types are stripped, not checked.
- The project's own transformers (`babel-jest` when the project has a Babel config, `ts-jest`, `@swc/jest`, …), as Jest runs them.
- `moduleNameMapper`, `moduleDirectories`, `modulePaths` and a custom `resolver`.
- **Environments:**
  - the `node` test environment;
  - `jsdom` or a custom environment, through the project's own environment class. For `jsdom` that's the project's `jest-environment-jsdom`, which must be installed, as with Jest.
  - The `@jest-environment` docblock works.
  - A custom environment's `handleTestEvent` is called with jest-circus's events, in its order (the objects are copies with circus's fields, not circus's own). A handler that throws fails what circus would fail: the hook or test at `hook_success` or `test_fn_success`, the whole file anywhere else. Not yet: `setup`'s `runtimeGlobals` is empty, `error` and `error_handled` are not sent, and a file a handler stopped still reports the tests that finished first.

**Your tests**
- Jest's globals: `describe`, `test`/`it`, the four hooks, `.only`/`.skip`, `.each` (with Jest's titles), `done` callbacks, and `import … from '@jest/globals'`.
- `expect` with Jest's matchers (copied from Jest), asymmetric matchers and `expect.extend`.
- Mock functions, spies, and `jest.mock` (hoisted, with a factory, automock or a `__mocks__` file), plus `clearMocks`, `resetMocks` and `restoreMocks`.
- Modern fake timers: `jest.useFakeTimers()` and the `fakeTimers` config key.
- `toMatchSnapshot`. Its `.snap` files are checked byte for byte against recordings of Jest 30.5.2, including the `-u` and `--ci` cases and obsolete snapshots.
- Inline snapshots (`toMatchInlineSnapshot`, `toThrowErrorMatchingInlineSnapshot`): a new one, or one that differs under `-u`, is written into the test file as Jest writes it, byte for byte against recordings of Jest 30.5.2. That covers JavaScript and TSX files, two calls on one line, `.resolves`/`.rejects`, property matchers and calls over several lines. The call is reprinted with Babel's generator, as Jest does; Babel loads only when a snapshot is written. The file is formatted with the project's Prettier 3. With Prettier 2, Provino writes the snapshot unformatted and warns.
- `snapshotResolver`: snapshots are written and read where the project's resolver says, and a resolver that lacks a member or doesn't invert itself fails each file with Jest's text.
- Snapshot files with no test file are reported as obsolete in the Snapshot Summary and removed under `-u`, through a custom resolver too.
- Retries with `jest.retryTimes(n, options)`, and of a whole describe block with `entireDescribe`.
- Random order with `--randomize` and `--seed`: a seed gives the order Jest gives, and `--showSeed` (or `--randomize`) prints it as the `Seed:` line before the totals.

**Output**
- The `default`, `verbose` and `summary` reporters print Jest's text (the failure text through `jest-message-util`, with a code frame, a console entry's call site, the per-file snapshot lines, the Snapshot Summary and `Ran all test suites.`), checked against recordings of Jest apart from the gaps below. `--verbose`, `--silent`, `--expand`, `--noStackTrace` and `--colors`/`--no-color` apply.
- Under an AI agent (`CLAUDECODE`, `AI_AGENT`, …) the `agent` reporter is chosen (failures and totals), and on GitHub Actions `github-actions` is added.
- `--reporters` and the `reporters` config key take Jest's built-ins (`default`, `verbose`, `summary` with `summaryThreshold`, `agent`, `github-actions`, with `silent: false` too: the result tree in `::group::` blocks) and any reporter module, by Jest's hooks (`onRunStart`, `onTestFileStart`, `onTestCaseResult`, `onTestFileResult`, `onRunComplete`, `getLastError`). jest-junit, jest-silent-reporter, jest-html-reporters, vscode-jest's reporter and a jest-sonar-reporter processor run on 20 files with Jest's text byte for byte, apart from the gaps below.
- `--logHeapUsage` ends each file's header with ` (<n> MB heap size)`, the heap in whole megabytes after the file ran (after a collection when `node --expose-gc` is on, as in Jest).
- `--notify` and `--notifyMode` (and the config keys) call `node-notifier` as Jest does, with Jest's titles and messages. Provino does not install it: it must be in the project, or in the install of `@jest/reporters`; without it the run ends before any file runs, with Jest's message and exit 1. Watch mode's "Run again" buttons are not built with it.
- `--detectLeaks` (and the `detectLeaks` key, per project) checks after each file that nothing still reaches its module registry or environment, and fails a file that does with Jest's `EXPERIMENTAL FEATURE!` text (a file-level failure that counts no test and starts no `--bail`, as in Jest). It is checked with `WeakRef`s and a forced garbage collection; it is refused under isolation `none`.
- The `dot`, `json` and `junit` reporters are Provino's own; choose them with `provino run --config <file> --reporter <name>`, Provino's config form.

## Not in place yet

These are the gaps the code itself names. Any other difference from Jest is a bug worth an issue.

| Gap | What happens today | Status |
| --- | --- | --- |
| Coverage from saved reports: `--merge-reports`, and coverage of changed files only | Not built. Workers and shards merge into one report in one run, but not from reports written earlier | Planned |
| Coverage HTML report | Written, but not compared byte for byte with Jest's (the other reporters are) | Not planned |
| Coverage under `provino run --config` | Only `provino jest` reads Jest's coverage keys; a Provino config has no coverage section yet | Planned |
| Coverage of a TypeScript file Provino's in-place strip can't take (a non-`declare` enum, a namespace with values, a parameter property, a decorator under `experimentalDecorators`, …) | The file is compiled and remapped instead, so a statement, function or branch end can be `null` and a `line` missing in `coverage-final.json` | Not planned |
| `coverageProvider: 'v8'`, exact positions | Statements, branches, functions and lines equal Jest's. Seventeen function and branch positions in the sample differ by a column (or a line at a line's end), and a TypeScript class's uninitialized fields count where Babel drops them. Both are pinned per Node version | Not planned |
| A worker that dies under `coverageProvider: 'v8'` (crash, out of memory, `--fileTimeout`, `--bail`) | V8 coverage is taken once per worker, so the files that worker ran before it died are lost (Jest loses only the file that was running) | Not planned |
| `_coverageSchema` in `coverage-final.json` and `--json`'s `coverageMap` | Jest's value, whatever the dialect | Not planned |
| Watch mode: `--watch`, `--watchAll` | Refused | Planned |
| A Jest reporter's own copy of Jest's frames | A report that embeds each failure's raw stack (jest-html-reporters, jest-sonar-reporter, jest-junit without `noStackTrace`) holds Provino's frames in place of `jest-circus`'s, with the project's frames in Jest's layout | Not planned |
| Coverage of only what changed: `--coverage` with `-o` or `--findRelatedTests` | The selected tests run, and coverage is collected as for a full run, not only of the changed files and the sources their tests import | Planned |
| A `snapshotResolver` that is broken | Each file fails with Jest's text and the run ends with no totals, exit 1, as in Jest; the error prints as `Provino: unexpected error:` with its stack, where Jest prints it red | Not planned |
| Inline snapshots with Prettier 2 | Written unformatted, with a warning (Prettier 3 formats as Jest does) | Not planned |
| Legacy fake timers | `legacyFakeTimers: true` throws when a test installs the timers, with a hint to use the modern ones. `jest.runAllImmediates` throws | Not planned |
| `provino vitest` | Refused | Next |
| RSpec-style lazy variables | A Provino extra, not a Jest feature: `import { lazy } from 'provino'` in a test file. It is never a global, and works with `injectGlobals: false` ([lazy variables](lazy-variables.md)) | Built |

## Checking discovery against Jest's

From a Provino checkout, `pnpm provino-bench list-tests ~/path/to/your-project` compares your project's `jest --listTests --json` with Provino's and names every difference, without running a test. It exits 0 when they match.
