---
"provino": minor
---

`import { lazy } from 'provino'` works in a test file under `provino jest` and `provino run`: `lazy`, `sharedExamples`, `itBehavesLike`, `includeExamples`, `sharedContext`, `includeContext`, `evaluatedLazies`, `LazyError` and the `Lazy` type. Lazy variables are a Provino extra, never a global, and need no `injectGlobals`.
