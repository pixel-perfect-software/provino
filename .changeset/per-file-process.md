---
"provino": patch
"@provino/dialect-jest": patch
"@provino/dialect-vitest": patch
"@provino/env-jsdom": patch
"@provino/env-node": patch
"@provino/types": minor
---

Each test file gets its own `process`, as Jest gives it: a copy of the worker's with listeners of its own and a copy of `env`, so an `exit`, `uncaughtException` or `SIGINT` listener a file (or its setup file) adds never reaches the next file in the worker and never runs at the worker's exit, a setup file that adds an `exit` listener per file no longer prints `MaxListenersExceededWarning`, and a file's `process.env` changes stay in the file. The `orchestrator` policy slice gains `processObject` (`'per-file' | 'shared'`: Jest and neutral `per-file`, Vitest `shared`), and `EnvironmentSetupContext` gains `processObject`, which `nodeEnvironment`, `jsdomEnvironment` and the Jest environment adapter read.
