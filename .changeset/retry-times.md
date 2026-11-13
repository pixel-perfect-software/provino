---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

`jest.retryTimes` runs: a failed test is retried after the rest of its describe (or at once with `retryImmediately`), as Jest does, with `waitBeforeRetry` and `logErrorsBeforeRetry`. `GlobalsHost` gains `setDefaultRetry`, and `@provino/types` the `DefaultRetry` it takes. `entireDescribe` is still refused by name. A test that already failed before it ran (a `beforeAll` error) is never retried, as Jest's. A test's `retry` option is checked when it is registered (`CORE_INVALID_ARGUMENT`), and a `g` or `y` RegExp `condition` is tested from the start each time. `CorePolicy.retry` gains `functionCondition` (`call` or `ignore-warn`): Vitest's dialect keeps Vitest's outcome, a function `condition` never called, and warns once a file.
