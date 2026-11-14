---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

`provino jest` runs Jest reporters: `--reporters` and the `reporters` config key take `default`, `agent`, `summary` (with `summaryThreshold`), `github-actions` and any module that exports a Jest reporter class, which is constructed and called as Jest calls it (`onRunStart`, `onTestFileStart`, `onTestCaseStart`, `onTestCaseResult`, `onTestFileResult`, `onRunComplete`, `getLastError`). A failed file prints Jest's own failure text and code frame, with Provino's frames hidden, and a console call under Jest keeps its call site (`at Object.log (file.test.ts:4:11)`). `provino run --reporter summary` prints the totals alone. `@provino/types` gains `TextStyle` and the policy key `orchestrator.consoleOrigin` (`stack` for Jest); `@provino/dialect-jest/node` gains `jestReporterPlan`, `loadJestReporters` and `createJestReporterHost`.
