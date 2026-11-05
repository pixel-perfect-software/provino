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
| `src/normalized-json/environment.ts` | `RunEnvironment` from `node:os` and `process` (the harness has the same; this package can't import it) |
| `src/sink.ts` | `TextSink`: anything with `write(chunk)`; a returned promise is awaited |
| `src/internal/serialize-error.ts` | Thrown value → `SerializedError` (same shape as `@provino/rpc`'s, which this package can't import) |
| `src/internal/test-support.ts` | Synthetic runs built to the real types: `buildFile`, `emitFile`, `playRun`, `recorder` |

## The bus

- Reporters get an event in registration order, each handler awaited before the next. **Events are delivered one at a time** in the order `emit` was called (an internal promise chain), so no reporter ever runs two handlers at once, and a slow reporter slows whoever emits (the workers, through the pack window). A reporter must not `await` the bus from a handler: it would wait on itself.
- A handler that throws or rejects never fails `emit`. The error is recorded and sent to every *other* reporter as `error(err, 'reporter')`; one that throws on *that* is recorded but not announced again. `failures()` is the recorded errors in order, then each reporter's `lastError()` as of the call; the coordinator turns a non-empty list into a failed run.
- A reporter added during an `emit` first sees the next event.

## The default reporter

- State lives in the closure, and `run:start` resets it. Per file: `PASS <path> (<ms> ms)`, `FAIL <path>` plus each failed test and its errors, or `SKIP <path>`. Failed tests are kept from `task:end` until their `file:end`. A file's own errors (a collection error, a worker crash) print under "Test suite failed to run", or "Errors outside the tests" when tests failed too. At `run:end`: unhandled errors from `RunSummary`, then `Test Suites:`, `Tests:`, `Time:` (the time is `RunSummary.durationMs`; the reporter has no clock). Counts come from `test-end` events, since `RunSummary` has none; a test that never ended isn't counted.
- An error prints its message (with `Name:` in front unless it is `Error` or the message already starts with it), the stack's `at` frames, then its `cause` and aggregated `errors` nested (three levels).

## The normalized-json reporter

- Identity is the file path, `TestTask.fullName` and `dupIndex`. Tests are listed in declaration order by walking the tree from the file node, since `file-collect-end.tasks` is only "parents before children". A test collected but never ended (or ended `queued`/`running`) is `notRun` with no assertion count or duration.
- A file with `workerExit`, or one that failed with no tests collected, is `crashed`; otherwise `failed`/`skipped`/`passed` from `FileResult.state`. `fileError` is the file's own errors (several are joined). An unhandled error tied to a file is added to that file (and fails a passing one); one tied to no file, and every `error` event, is a `runErrors` entry.
- `success` is false for a failed or crashed file, a run error, or an `interrupted` run. `snapshots`, `console` and `trace` are left out (T12.16). `retries`, `expectedToFail` and `location` are filled the way the harness's Jest converter fills them.
- `startedAt` is the wall clock at `run:start` (`now`, default `Date.now`). A failed write throws out of `run:end`, so the bus records it and the run fails.
- The tests assert the JSON's shape directly: `parseNormalizedRun` lives in `@provino/harness`, which this package's manifest node may not import. B11's bench check runs it on real output.

## Not built yet

- Other built-in reporters, custom reporter modules, the TTY live view, `console` output in `default`, and goldens (T9.7, B21).
- The normalized run's `console`, `trace` and snapshot state (T12.16); error `userFrame` and ANSI-aware normalisation beyond stripping `message` (the harness's normaliser).
