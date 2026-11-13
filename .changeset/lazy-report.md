---
"@provino/types": minor
"@provino/lazy": minor
"provino": minor
---

A failed test's report lists the lazy values it evaluated (where each is defined and how long it took) and, for a definition that threw, the chain of reads that led to it (`chain: cart -> user`). `@provino/types` gains `LazyEvaluation` and `TaskResult.lazies`, filled on a failed `test-end` only. `@provino/lazy` marks a thrown definition value under `LAZY_CHAIN`, and its `evaluatedLazies` now returns `LazyEvaluation` in place of the `EvaluatedLazy` beta type, which is gone.
