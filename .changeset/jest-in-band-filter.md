---
"provino": minor
"@provino/types": minor
"@provino/dialect-jest": minor
---

`provino jest` runs in band as Jest does, and takes `--filter`, `--projects` and `--debug` (T9.9). `-i`, one file, one worker, or up to 20 files that ran under a second last time (and no `workerIdleMemoryLimit`) run the files in the bin's own process, with a test's `console` still buffered per file, so a test sees what the global setup put on `globalThis`. The `orchestrator` policy slice's `runInBand: { auto }` becomes `inBand: { single, fastFileCount, slowMs }` (Jest `{ true, 20, 1000 }`; Vitest and neutral `{ false, 0, 0 }`), and `WorkerInit` gains `captureConsole`. `--filter` loads a module that returns `{ filtered }` per project (with Jest's `setup`, `--skipFilter` and its errors), `--projects` reads the configs of the paths it lists, and `--debug` prints `{ configs, globalConfig, version }` before the run. `@provino/dialect-jest/node` gains `loadJestFilter` and `jestDebugText`.
