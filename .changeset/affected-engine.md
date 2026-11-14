---
"provino": minor
"@provino/types": patch
---

The affected-test engine (nothing in `provino jest` selects by it yet). The coordinator can build a project's dependency graph (`createAffectedIndex`) and answer which test files a change reaches: a change to a leaf selects the tests whose closure holds it, a changed `.snap` selects its test, mock files are edges as the policy says, and a change to the project's own inputs selects what `affected.invalidateAll` says. `runProjects` now applies `selection` and `onlyFailures`, and records the modules each test file loaded for the neutral policy's recorded graph. The loader's `Loader.dropRecords` and `CoordinatorLoader.resolveDependency` are built.

`OrchestratorPolicy.affected` gains `conditions` (`environment` neutral, `none` under Jest: an edge resolves with `require`, `node` and `default`), and `SerializedLoaderConfig` and `NeutralResolution` gain `skipNodeResolution` (Jest's key, which the graph now applies).
