---
"@provino/lazy": minor
---

New package `@provino/lazy`: the public types of lazy variables (`Lazy`, `LazyApi`, `Values`, `ReservedKey`, the shared-example and shared-context types), `LazyError` with its codes, `LAZY_CHAIN`, and the `lazy`, `sharedExamples`, `itBehavesLike`, `includeExamples`, `sharedContext`, `includeContext` and `evaluatedLazies` entry points. They read the runtime the worker installs under `Symbol.for('provino.lazy.runtime')` and throw `LAZY_NO_RUNTIME` without one. The runtime arrives in later changes.
