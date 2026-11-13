---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

`provino jest --json` writes Jest's results: `--json` prints them on stdout (or to `--outputFile`, saying `Test results written to: <path>`), `--useStderr` sends the rest of the output to stderr, `--testLocationInResults` adds each test's `location`, and a `testResultsProcessor` receives Jest's `AggregatedResult` and its return value is what is written and decides the exit code. `@provino/dialect-jest` gains the `./results` entry (Jest 30.5's result shapes and the collector that builds them from a run's events), and `@provino/types` gains `SerializedError.details`, `FileResult.snapshot` and `FileInfo.projectIndex`.
