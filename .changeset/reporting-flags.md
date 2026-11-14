---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

`provino jest` applies `--showSeed`, `--logHeapUsage`, `--notify`, `--notifyMode` and `--detectLeaks` (and the config keys of the same names); none is refused or warned about any more. The summary has a `Seed:` line before `Test Suites:` when the seed is shown (`--randomize` shows it too), a file's header ends ` (<n> MB heap size)` under `--logHeapUsage`, and `--notify` calls `node-notifier` as Jest's `NotifyReporter` does, found in the project and then in its `@jest/reporters` install (Provino has no dependency on it; without it the run ends with Jest's message and exit 1). `--detectLeaks` checks, after each file's teardown, that nothing still reaches its registry or environment, and fails a file that is held with Jest's text; it is refused with `ORCH_BAD_OPTION` under isolation `none`.

`FileJob` gains `detectLeaks` and `logHeapUsage`, `FileResult` gains `leaks` and `heapUsedBytes`, the worker's `fileDone` gains `leaks` and `heapUsedBytes`, `FileRegistry` gains the optional `leakTargets()`, and the dialect exports `createNotifyReporter`, `loadJestNotifier`, `JestNotifierMissingError` and `LEAK_MESSAGE`. The text reporters' options gain `seed`.
