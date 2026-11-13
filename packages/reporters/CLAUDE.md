# @provino/reporters

The reporter bus and the two built-in reporters B11 needs (coordinator side; imports `@provino/types` and Node builtins only). It reads the `report` policy slice, and only through `defaultReporter`'s `report` option.

## Map

| Path | Role |
|---|---|
| `src/bus.ts` | `createReporterBus(reporters?)` → `ReporterBusHandle` (`ReporterBus` + `failures()`) |
| `src/define.ts` | `defineReporter`: the type check, nothing else |
| `src/default/reporter.ts` | `defaultReporter({ stream, report })`: Jest-like text, no colour, no live view |
| `src/default/format.ts` | Every string the default reporter prints. Not a golden (T9.7 adds those) |
| `src/normalized-json/reporter.ts` | `normalizedJsonReporter(options)`: collects events, writes one `NormalizedRun` at `run:end` |
| `src/normalized-json/build.ts` | The pure part: `testsInOrder`, `normalizeError`, `buildNormalizedRun` |
| `src/normalized-json/environment.ts` | `RunEnvironment` from `node:os` and `process` (the harness has the same; this package can't import it); `ci` from `CI` (trimmed, lowercased, not empty, `0` or `false`) when the reporter isn't given one |
| `src/sink.ts` | `TextSink`: anything with `write(chunk)`; a returned promise is awaited |
| `src/internal/serialize-error.ts` | Thrown value → `SerializedError` (same shape as `@provino/rpc`'s, which this package can't import) |
| `src/internal/test-support.ts` | Synthetic runs built to the real types: `buildFile`, `emitFile`, `playRun`, `recorder` |

## The bus

- Reporters get an event in registration order, each handler awaited before the next. **Events are delivered one at a time** in the order `emit` was called (an internal promise chain), so no reporter ever runs two handlers at once, and a slow reporter slows whoever emits (the workers, through the pack window). A reporter must not `await` the bus from a handler: it would wait on itself.
- A handler that throws or rejects never fails `emit`. The error is recorded and sent to every *other* reporter as `error(err, 'reporter')` **right after that handler fails, before the remaining reporters get the event**; one that throws on *that* is recorded but not announced again. `failures()` is the recorded errors in order, then each reporter's `lastError()` as of the call; the coordinator turns a non-empty list into a failed run.
- So a reporter registered *after* a failing one sees the failure before the event, and one registered *before* it sees the failure after. A reporter that must record a failure at `run:end` (normalized-json) has to be registered last; `provino` does that.
- A reporter added during an `emit` first sees the next event.

## The default reporter

- State lives in the closure, and `run:start` resets it. Per file: `PASS <path> (<ms> ms)`, `FAIL <path>` plus each failed test and its errors, or `SKIP <path>`; a project with a name (Jest's `displayName`) puts it before the path (`PASS server a.test.ts`), as Jest's header does (B17d). Failed tests are kept from `task:end` until their `file:end`; so are suites that end `fail` with errors of their own (an `afterAll` that threw, under `hooks.afterAllError: 'fail-suite'`), printed as a block titled with the suite's name path (built from that file's `file:collected` tree only when the suite failed; the tree, like the failures, is dropped at the file's `file:end`) after the failed tests. A file's own errors (a collection error, a worker crash) print under "Test suite failed to run", or "Errors outside the tests" when tests failed too. At `run:end`: unhandled errors from `RunSummary`, the obsolete snapshots by file (`obsoleteBlock`, when `summary.snapshots` has any), then `Test Suites:`, `Tests:`, Jest's `Snapshots:` line (`snapshotLine`: failed, obsolete, file removed, updated, written, passed, total; zero parts left out except `total`; absent when no snapshot was checked, written or obsolete), `Time:` (the time is `RunSummary.durationMs`; the reporter has no clock). Counts come from `test-end` events, since `RunSummary` has none; a test that never ended isn't counted.
- An error prints its message (with `Name:` in front unless it is `Error` or the message already starts with it), the stack's `at` frames, then its `cause` and aggregated `errors` nested (three levels).

- **The summary is Jest's `getSummary`** (B21a): a count of zero is left out (`Test Suites: 1 failed, 1 total`; the `total` stays), and the suites read `N of M total` whenever the suites that ran (failed plus passed, so not a skipped file) differ from the files `run:start` announced: a run that bailed (`1 of 3 total`) and a run with a skipped file (`1 skipped, 1 passed, 1 of 2 total`), both recorded from Jest (`cli/bail-one`, `cli/skipped-file`, `cli/skipped-file-alone`). Two differences from Jest remain: a file whose tests are only `todo`, or `skip` and `todo`, is a `SKIP` file here and a passed suite there (Jest marks a suite skipped only when every test is `skip`), and Jest prints no line for a skipped suite. After it, a `RunSummary.openHandles` that is there (the orchestrator leaves it out when it found none, so the reporter does not check for an empty list) prints as Jest's report (`openHandlesText`): the count, then each handle's `●  <kinds>`, its code frame indented 4 and its frames indented 6, two blank lines between handles. The wording says "Jest" for every dialect until T9.7 makes it a policy value.

## The normalized-json reporter

- Identity is the file path, `TestTask.fullName` and `dupIndex`. Tests are listed in declaration order by walking the tree from the file node, since `file-collect-end.tasks` is only "parents before children". A test collected but never ended (or ended `queued`/`running`) is `notRun` with no assertion count or duration.
- A file with `workerExit`, or one that failed with no tests collected, is `crashed`; otherwise `failed`/`skipped`/`passed` from `FileResult.state`. `fileError` is the file's own errors, the errors of its failed suites (`suite-end` with `state: 'fail'`) and the unhandled ones charged to it (several are joined). An unhandled error tied to a file is added to that file (and fails a passing one); one tied to no file, and every `error` event, is a `runErrors` entry. One charged to a test of the file (`ownerId` is a collected test: Jest's `errors.lateErrors: 'fail-owner'`, T5.11) is that test's failure instead: the test is `failed` with the error appended to its own, and its file `failed`, with no `fileError`. The default reporter prints it under that test and moves it from passed to failed in the tally.
- `success` is false for a failed or crashed file, a run error, or a run whose `reason` isn't `passed` (an `interrupted` one, or one the orchestrator failed on its snapshots with every file green). `snapshots` is `RunSummary.snapshots`' totals and the `.snap` files the run left, each with the sha256 of its bytes and its path POSIX and relative to `run:start`'s `root` (`normalizeSnapshots`; a file that can't be read is left out); `trace` (T12.7) is left out. `expectedToFail` and `location` are filled the way the harness's Jest converter fills them. `retries` counts `test:attempt-end` events with `willRetry` (real retries only: `TaskResult.attempts` also counts repeats); without any attempt events it falls back to `attempts - 1`, unless the test repeated, when it is left out.
- **Console** (B15): every `console` bus event is kept in the file's record and written split on `\n` (a trailing newline ends the last line, so `console.log('')` is one empty line), with `stream` and `level` (none for a direct stream write). A write whose `taskId` is one of the file's tests goes on that test, its each-hooks included; a suite's or the file's `beforeAll`/`afterAll`, the top level and a write outside any task go on the file. A file or test that wrote nothing has no `console` key. The text is as the worker captured it: the harness's `convertProvino` normalizes it.
- `unhandledErrors` (`'fail-run'` default, or `'ignore'`) mirrors the orchestrator's policy: under `ignore` unhandled errors are still recorded (`fileError`, `runErrors`) but fail neither a passing file nor `success`. `error` events (including `reporter` ones) always count. `provino` passes the policy's value.
- `outputFile` is written to `<path>.<pid>.<random>.tmp` beside it and renamed over it, so concurrent runs and a kill mid-write never leave corrupt JSON; a failed write removes the temp file.
- `env.ci` is the `ci` option when given (over `env.ci` of an `env` option too): `provino`'s `run()` passes the ci it resolved, so the file agrees with the run. Only without one does the reporter read `CI` itself, by the same rule.
- `startedAt` is the wall clock at `run:start` (`now`, default `Date.now`). A failed write throws out of `run:end`, so the bus records it and the run fails.
- The tests assert the JSON's shape directly: `parseNormalizedRun` lives in `@provino/harness`, which this package's manifest node may not import. B11's bench check runs it on real output.

## Not built yet

- Other built-in reporters, custom reporter modules, the TTY live view, `console` output in `default`, and goldens (T9.7, B21).
- The normalized run's `trace` (T12.7, B21); error `userFrame` and ANSI-aware normalisation beyond stripping `message` (the harness's normaliser, which `convertProvino` applies).
