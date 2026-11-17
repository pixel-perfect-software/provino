# @provino/lazy

## 0.1.0-rc.1

### Patch Changes

- @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Minor Changes

- dd8b08f: A failed test's report lists the lazy values it evaluated (where each is defined and how long it took) and, for a definition that threw, the chain of reads that led to it (`chain: cart -> user`). `@provino/types` gains `LazyEvaluation` and `TaskResult.lazies`, filled on a failed `test-end` only. `@provino/lazy` marks a thrown definition value under `LAZY_CHAIN`, and its `evaluatedLazies` now returns `LazyEvaluation` in place of the `EvaluatedLazy` beta type, which is gone.
- cf22585: New package `@provino/lazy`: the public types of lazy variables (`Lazy`, `LazyApi`, `Values`, `ReservedKey`, the shared-example and shared-context types), `LazyError` with its codes, `LAZY_CHAIN`, and the `lazy`, `sharedExamples`, `itBehavesLike`, `includeExamples`, `sharedContext`, `includeContext` and `evaluatedLazies` entry points. They read the runtime the worker installs under `Symbol.for('provino.lazy.runtime')` and throw `LAZY_NO_RUNTIME` without one. The runtime arrives in later changes.

### Patch Changes

- Updated dependencies [063753f]
- Updated dependencies [dbe800f]
- Updated dependencies [e79a080]
- Updated dependencies [f6e0ab6]
- Updated dependencies [73dbb1b]
- Updated dependencies [983f094]
- Updated dependencies [0b12a9f]
- Updated dependencies [7c3711a]
- Updated dependencies [4feaef4]
- Updated dependencies [a9571da]
- Updated dependencies [26ed357]
- Updated dependencies [26ed357]
- Updated dependencies [ddb10bf]
- Updated dependencies [646c3e3]
- Updated dependencies [646c3e3]
- Updated dependencies [475232b]
- Updated dependencies [5ec4d3b]
- Updated dependencies [209f097]
- Updated dependencies [3872fb2]
- Updated dependencies [14850e9]
- Updated dependencies [c5230cd]
- Updated dependencies [493ebff]
- Updated dependencies [929e910]
- Updated dependencies [09fc2b2]
- Updated dependencies [a43cb01]
- Updated dependencies [f7a629d]
- Updated dependencies [f7a629d]
- Updated dependencies [a602762]
- Updated dependencies [dd8b08f]
- Updated dependencies [cffb867]
- Updated dependencies [9a55f65]
- Updated dependencies [2da1a4b]
- Updated dependencies [d464f91]
- Updated dependencies [133727f]
- Updated dependencies [a56ca80]
- Updated dependencies [3872fb2]
- Updated dependencies [6186141]
- Updated dependencies [fe9ad4f]
- Updated dependencies [a2764b2]
- Updated dependencies [1f0842e]
- Updated dependencies [3a87631]
- Updated dependencies [d3d0649]
- Updated dependencies [26ed357]
- Updated dependencies [4f255d8]
- Updated dependencies [a21fdff]
  - @provino/types@0.1.0-rc.0
