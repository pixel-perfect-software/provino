---
"provino": patch
---

A native test file can reset its modules: `resetModules()`, `isolateModules(fn)` and `isolateModulesAsync(fn)` from `provino` (also globals under `globals: true`). Each isolation returns its callback's value, and a `mock()` at the top of its callback is hoisted to the top of the callback, so it registers inside the isolation. A `require` of a mocked module settles the mock at once when it can: a factory that returns no Promise, or an automock or `__mocks__` file built through a synchronous load; a factory that returns a Promise, or a graph with top-level await, is refused by name.
