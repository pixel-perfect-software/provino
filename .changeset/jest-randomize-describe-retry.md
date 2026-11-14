---
"provino": minor
"@provino/types": minor
"@provino/dialect-jest": minor
---

`provino jest --randomize` and `--seed` (T5.13): each file's suites are shuffled with jest-circus's own generator (pure-rand's xoroshiro128+ and Fisher-Yates), so a seed gives the order Jest gives, and the results and the verbose list show the tests in that order. The `core` slice gains `shuffle` (`ShuffleFactory`; `null` cannot shuffle, Jest's is `jestShuffle` from `@provino/dialect-jest/runtime`), `SerializedProjectConfig` and `NeutralProject` gain `randomize`, and `TaskResult` and `FileResult` gain `childOrder`, the order a shuffled suite ran its children in.

`jest.retryTimes(n, { entireDescribe: true })` (T5.10): a describe block, or the whole file when called at its top level, runs again, hooks and every test below, while a test in it fails; the last attempt stands, with the dropped attempts' errors kept under `logErrorsBeforeRetry`. `GlobalsHost` gains `setDescribeRetry`, and `DescribeRetry` and `DescribeRetryResult` are exported.
