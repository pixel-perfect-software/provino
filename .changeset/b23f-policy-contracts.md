---
'provino': patch
'@provino/dialect-jest': patch
'@provino/dialect-vitest': patch
'@provino/types': minor
---

Three policy keys for the last Jest 30.5.2 differences, with nothing reading them yet: `ModulePolicy.reevaluatePatchingExternals` (a shared package that replaces a watched global or builtin export is evaluated per file; Jest `true`, neutral and Vitest `false`), `ExpectPolicy.outsideTestCounts` (`'drop'` or `'next-test'`: where the assertion counters made outside a test go; Jest `'next-test'`, neutral and Vitest `'drop'`), and `CorePolicy.boundaryTurns` gains `skippedTest`, `suiteStart`, `suiteEnd`, `runStart`, `retry`, `retryEnd` (an attempt that ends inside jest-circus's retry loop) and `retryExit`, with Jest's recorded values (`runtime/microtask-turns-*`). `LifecycleListener` and `EnvironmentInstance.onTestEvent` may return any thenable, not only a `Promise`.
