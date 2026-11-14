---
"provino": minor
"@provino/types": minor
"@provino/dialect-jest": minor
---

`provino jest --randomize` and `--seed` (T5.13): each file's suites are shuffled with jest-circus's own generator (pure-rand's xoroshiro128+ and Fisher-Yates), so a seed gives the order Jest gives, and the results and the verbose list show the tests in that order. The `core` slice gains `shuffle` (`ShuffleFactory`; `null` cannot shuffle, Jest's is `jestShuffle` from `@provino/dialect-jest/runtime`), `SerializedProjectConfig` and `NeutralProject` gain `randomize`, and `TaskResult` and `FileResult` gain `childOrder`, the order a shuffled suite ran its children in.

`jest.retryTimes(n, { entireDescribe: true })` (T5.10): a describe block, or the whole file when called at its top level, runs again, hooks and every test below, while a test in it fails; the last attempt stands, with the dropped attempts' errors kept under `logErrorsBeforeRetry`. `GlobalsHost` gains `setDescribeRetry`, and `DescribeRetry` and `DescribeRetryResult` are exported.

A dropped describe attempt is reported as Jest reports it: each test in it has a `test-attempt-end` with `willRetry: true`, which now carries the attempt's own `assertions` and `passingAssertions` (`RuntimeEvent`), so a Jest reporter's `onTestCaseResult` hears every attempt with its status and passing assertions, and the result of the attempt that stood carries that attempt's counts. Blocks that run side by side keep their attempts apart, an error a test had before the attempt (a parent `beforeAll`'s) no longer retries the block, an error charged late to an ended test retries it as jest-circus does, and a fractional `--seed` is taken as Jest takes it.
