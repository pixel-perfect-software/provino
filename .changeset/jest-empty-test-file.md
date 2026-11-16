---
"provino": patch
"@provino/types": patch
"@provino/dialect-jest": patch
"@provino/dialect-vitest": patch
---

`provino jest` fails a matched test file that declares no tests, as Jest 30.5.2 does. A helper under `__tests__`, or a file of one empty `describe`, is a `FAIL` line with "Your test suite must contain at least one test.", counts as a failed suite, ends the run with exit code 1 (also under `--passWithNoTests`, which is about finding no files), and is `failed` with that message in `--json`, where Provino reported it as passed (`skipped` in `--json`). A file whose tests are all skipped or todo declared some, so it is unchanged. The `orchestrator` policy slice gains `noTestsFile: 'fail' | 'pass'` (Jest `fail`; neutral and Vitest `pass`, as before), and `FileResult` gains `noTests`, set on a file the orchestrator failed for this, which the Jest dialect's result builder words as Jest does.
