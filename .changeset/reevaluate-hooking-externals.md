---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

`provino jest` evaluates a package in `node_modules` again in each test file when, as it first loads in a worker, it reads a per-file global: a test hook, `jest` or `expect`, or a global the environment installed (`document`, `window`, …), as Jest evaluates node_modules per file. React Testing Library's `afterEach(cleanup)` and `screen`, `@testing-library/jest-dom`'s `expect.extend`, jest-canvas-mock, jest-styled-components, jest-extended and jest-fetch-mock now work in every file of a worker, not only the first. What a worker learns is kept in the results cache, so the next run evaluates those packages per file from its first file. A package whose own code requires `@jest/globals` (jest-mock-extended) gets Provino's module, not the real one that refuses to load. Other dialects keep one evaluation per worker.

`@provino/types`: `ModulePolicy.reevaluateHookingExternals`, `Loader.watchExternalLoads`, `reevaluatedExternals` and `reevaluateExternals`, `ExternalLoadWatcher`, `SerializedLoaderConfig.reevaluate` and `fileDone.reevaluated`; `EnvironmentInstance.globalReads` and `GlobalReadWatch` (an environment's populated accessors report reads, so the worker's watch redefines none of them); `SerializedError.enumerableFields` (which of `name`, `message` and `stack` the thrown value had as its own enumerable fields, for `--json`'s `failureDetails`).
