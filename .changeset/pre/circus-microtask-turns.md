---
'provino': patch
'@provino/dialect-jest': patch
'@provino/types': minor
---

`provino jest` gives a promise chain a test leaves running as many microtask turns before the next hook or test as Jest 30.5.2 does: 20 from a test's end to its `afterEach`, 21 between hooks, 67 from the last `afterEach` to the next test's `beforeEach`, 66 between tests with no hooks. jest-circus awaits its six event handlers at every event it dispatches; Provino's own code took 2 turns, so an axios interceptor chain reached its mock adapter after `afterEach` had reset it, and a react-hook-form update landed outside `act()`. `CorePolicy.boundaryTurns` (`BoundaryTurns`) holds each boundary's turns; the neutral and Vitest values are all 0.
