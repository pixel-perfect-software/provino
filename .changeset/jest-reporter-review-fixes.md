---
'provino': patch
'@provino/dialect-jest': patch
---

Fixes from the pre-merge review of the reporter host: an install's `node_modules/provino` frames and a percent-encoded checkout path are hidden from Jest's failure text; a console `warn` or `error` keeps its whole stack (a code frame and every frame outside Provino) and a `prepareStackTrace` that returns no string no longer throws in the test's call; `getLastError()` fails the run for any truthy value (`JestReporterInstance.getLastError` returns `unknown`); `onRunComplete` hears `success: false` as Jest's does; `showStatus` follows Jest's in-band rule; `default` is verbose only when a project that runs is; `summaryThreshold: null` is Jest's default; an error a reporter throws is printed when no text reporter shows it; `Test run was interrupted.` is printed in watch mode only; the `github-actions` option `silent: false` is refused by name.
