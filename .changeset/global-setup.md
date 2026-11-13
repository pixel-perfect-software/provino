---
"provino": minor
"@provino/dialect-jest": minor
"@provino/dialect-vitest": minor
"@provino/types": minor
---

`provino jest` runs the project's `globalSetup` and `globalTeardown` in the coordinator, as Jest does: once per distinct path, in the order Jest's sequenced list reaches the projects, then the root config's own hooks (Jest's `globalConfig.globalSetup`, with `projects`), with `(globalConfig, projectConfig)`, through the project's transform (a TypeScript file, or one babel-jest or ts-jest handles). `globalConfig.testPathPatterns` is the `TestPathPatterns` object Jest 30 passes. A hook that throws ends the run with Jest's text, class and exit code, and a thrown value that is no Error is printed as pretty-format prints it. Ctrl+C or SIGTERM stops waiting for a hook that hangs, and the second Ctrl+C does not wait for a teardown. `OrchestratorPolicy.globalSetup` gains `teardownOrder`, `failureMessage`, `formatThrown` and `reviveArgs` (types `GlobalSetupArgs` and `ReviveGlobalSetupArgs`; `@provino/dialect-jest/runtime` exports `reviveGlobalSetupArgs`), `NeutralProject` gains `globalSetupArgs`, and each file now sends one `deps` event with the modules it loaded, as `WorkerEvent`'s `{ added, ids }`: a worker names each module path once and sends its number after that.
