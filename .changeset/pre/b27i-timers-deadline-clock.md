---
"provino": patch
"@provino/dialect-jest": patch
---

Fake timers no longer make a test or its hook "time out" at once. After `timers.setSystemTime(date)` and `timers.clearAllTimers()`, the fake `performance.now()` sat years from the real one, and the runtime read it for its own deadlines. A test (a past date) or its `afterEach` (a future one) ended "Test timed out" or "Hook timed out in 10000ms" without waiting, and an async test could get a 1 ms deadline or none. The runtime now reads the clock it captured before any test code ran, as it does for its timers. Under the Jest dialect, a custom environment's `handleTestEvent` no longer hears a negative `test.duration` after `jest.setSystemTime`: `startedAt` and `duration` read the real `Date.now`, as jest-circus's do.
