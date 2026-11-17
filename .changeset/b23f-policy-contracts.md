---
'provino': patch
'@provino/dialect-jest': patch
'@provino/dialect-vitest': patch
'@provino/types': minor
---

Three policy keys for the last Jest 30.5.2 differences, with nothing reading them yet: `ModulePolicy.reevaluatePatchingExternals` (a shared package that replaces a watched global or builtin export is evaluated per file; Jest `true`, neutral and Vitest `false`), `ExpectPolicy.outsideTestCounts` (`'drop'` or `'next-test'`: where the assertion counters made outside a test go; Jest `'next-test'`, neutral and Vitest `'drop'`), and `CorePolicy.boundaryTurns` gains `skippedTest`, `suiteStart`, `suiteEnd`, `runStart`, `retry` and `events` (`BoundaryEvents`, the events dispatched in each boundary). The Jest values are research values until each lane records them.
