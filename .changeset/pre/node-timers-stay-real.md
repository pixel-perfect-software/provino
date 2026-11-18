---
'@provino/timers': patch
'provino': patch
---

`useFakeTimers()` no longer fakes the exports of `node:timers` and `node:timers/promises`, as neither Jest nor Vitest does. React's async `act` resolves through `require('timers').setImmediate`, so a `findBy*` or `waitFor` under fake timers hung in a worker's first file, while React was still loaded once for the worker.
