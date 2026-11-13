# Jest compatibility

What `provino jest` does and doesn't do today. Provino matches the behaviour of Jest 30.5.

## What works

Provino's tests compare almost everything here with Jest 30.5, either against recordings of the real runner or with Jest running beside Provino on the same project. The one exception is `--showConfig`, which prints Provino's own reading of the config and isn't compared with Jest's output.

**The command line and config**
- Jest's own flags and config keys, including any config key given as a flag (`--testMatch`, `--roots`, `--testTimeout`, …), and Jest's exit codes. A flag Provino can't run yet is refused by name, never ignored without saying so.
- A config with several `projects`, run in one pool. `--selectProjects` and `--ignoreProjects` work.
- Test path patterns, `--runTestsByPath`, `-t`, `-u`/`--updateSnapshot`, `-w`/`-i`, `--ci`, `--passWithNoTests`, `--no-cache`, `--listTests [--json]`, `--showConfig` and `--clearCache`.
- `--json`, `--outputFile`, `--useStderr`, `--testLocationInResults` and `testResultsProcessor`: the results file has Jest's keys and values, and the processor gets and returns Jest's object. `--collectTests` imports each file, runs no test and prints Jest's tree or JSON.
- `--bail`, `--forceExit`, `--detectOpenHandles`, `workerIdleMemoryLimit`, and `--shard=i/n`. A shard is Jest's split, or a cut by time from a timings file, with Provino's own `--timings` and `--update-timings`.
- Ctrl+C stops the run and exits 130; a second Ctrl+C kills every worker at once. SIGTERM exits 143.
- `globalSetup` and `globalTeardown`, run once per project and path, as Jest runs them.

**Your code**
- TypeScript, TSX, JSX and JavaScript, compiled with Oxc. Types are stripped, not checked.
- The project's own transformers (`babel-jest` when the project has a Babel config, `ts-jest`, `@swc/jest`, …), as Jest runs them.
- `moduleNameMapper`, `moduleDirectories`, `modulePaths` and a custom `resolver`.
- **Environments:**
  - the `node` test environment;
  - `jsdom` or a custom environment, through the project's own environment class. For `jsdom` that's the project's `jest-environment-jsdom`, which must be installed, as with Jest.
  - The `@jest-environment` docblock works.

**Your tests**
- Jest's globals: `describe`, `test`/`it`, the four hooks, `.only`/`.skip`, `.each` (with Jest's titles), `done` callbacks, and `import … from '@jest/globals'`.
- `expect` with Jest's matchers (copied from Jest), asymmetric matchers and `expect.extend`.
- Mock functions, spies, and `jest.mock` (hoisted, with a factory, automock or a `__mocks__` file), plus `clearMocks`, `resetMocks` and `restoreMocks`.
- Modern fake timers: `jest.useFakeTimers()` and the `fakeTimers` config key.
- `toMatchSnapshot`. Its `.snap` files are checked byte for byte against recordings of Jest 30.5.2, including the `-u` and `--ci` cases and obsolete snapshots.
- Retries with `jest.retryTimes(n, options)`.

**Output**
- The `default`, `verbose` and `summary` reporters print Jest's text (the failure text through `jest-message-util`, with a code frame, a console entry's call site, the per-file snapshot lines, the Snapshot Summary and `Ran all test suites.`), checked against recordings of Jest apart from the gaps below. `--verbose`, `--silent`, `--expand`, `--noStackTrace` and `--colors`/`--no-color` apply.
- Under an AI agent (`CLAUDECODE`, `AI_AGENT`, …) the `agent` reporter is chosen (failures and totals), and on GitHub Actions `github-actions` is added.
- `--reporters` and the `reporters` config key take Jest's built-ins (`default`, `verbose`, `summary` with `summaryThreshold`, `agent`, `github-actions`) and any reporter module, by Jest's hooks (`onRunStart`, `onTestFileStart`, `onTestCaseResult`, `onTestFileResult`, `onRunComplete`, `getLastError`). jest-junit, jest-silent-reporter, jest-html-reporters, vscode-jest's reporter and a jest-sonar-reporter processor run on 20 files with Jest's text byte for byte, apart from the gaps below.
- The `dot`, `json` and `junit` reporters are Provino's own; choose them with `provino run --config <file> --reporter <name>`, Provino's config form.

## Not in place yet

These are the gaps the code itself names. Any other difference from Jest is a bug worth an issue. Provino warns about the config keys it reads but can't apply (`collectCoverage`, `snapshotResolver`).

| Gap | What happens today | Status |
| --- | --- | --- |
| Coverage: `--coverage`, `--collectCoverage` | The flags are refused (exit 1). `collectCoverage: true` in the config warns, and the run goes ahead without coverage | Planned |
| Watch mode: `--watch`, `--watchAll` | Refused | Planned |
| A Jest reporter's own copy of Jest's frames | A report that embeds each failure's raw stack (jest-html-reporters, jest-sonar-reporter, jest-junit without `noStackTrace`) holds Provino's frames in place of `jest-circus`'s, with the project's frames in Jest's layout | Not planned |
| `github-actions` with `silent: false` | The result tree it adds is not printed | Planned |
| Orphan `.snap` files | Not removed, and `snapshot.filesRemovedList` stays empty | Planned |
| Run only what changed: `--onlyChanged`, `--changedSince`, `--lastCommit`, `--changedFilesWithAncestor`, `--findRelatedTests`, `--onlyFailures` | Refused | Not yet planned |
| Random order: `--randomize`, `--seed`, `--showSeed` | Refused | Not yet planned |
| `--detectLeaks` | Refused | Planned |
| `--filter`, and the `--projects` flag | Refused (a `projects` key in the config does run) | Not yet planned |
| `--debug`, `--logHeapUsage`, `--notify`, `--notifyMode` | Warn, and are otherwise ignored | Planned |
| `snapshotResolver` | Warns; snapshots stay beside the test file | Planned |
| Writing inline snapshots (`toMatchInlineSnapshot`) | A match passes and a mismatch fails; one that would need writing (a new one, or `-u`) fails with a message | Planned |
| `jest.retryTimes(n, { entireDescribe })` | Throws | Planned |
| `-i`/`--runInBand` with `globalSetup` globals | A worker still starts, so a test doesn't see a global that `globalSetup` set, as it would in Jest | Planned |
| A custom environment's `handleTestEvent` | Not called | Planned |
| Legacy fake timers | `legacyFakeTimers: true` throws when a test installs the timers, with a hint to use the modern ones. `jest.runAllImmediates` throws | Not planned |
| `provino vitest` | Refused | Next |
| RSpec-style lazy variables | Not built | Planned |

## Checking discovery against Jest's

From a Provino checkout, `pnpm provino-bench list-tests ~/path/to/your-project` compares your project's `jest --listTests --json` with Provino's and names every difference, without running a test. It exits 0 when they match.
