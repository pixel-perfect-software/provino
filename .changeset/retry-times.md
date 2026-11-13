---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

`jest.retryTimes` runs: a failed test is retried after the rest of its describe (or at once with `retryImmediately`), as Jest does, with `waitBeforeRetry` and `logErrorsBeforeRetry`. `GlobalsHost` gains `setDefaultRetry`, and `@provino/types` the `DefaultRetry` it takes. `entireDescribe` is still refused by name.
