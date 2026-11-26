# @provino/policy

## 0.1.0-rc.8

### Patch Changes

- Updated dependencies [4534450]
  - @provino/types@0.1.0-rc.8

## 0.1.0-rc.7

### Patch Changes

- 021f020: Projects with no dialect now get Node's own ES module interop: a CommonJS module's default import is `module.exports`.
- 26b1b86: A native project (no dialect) with `environment: 'jsdom'` and no `isolation` now runs under `provino run`. Its default tier was `realm`, which is not built, so every file failed with "the realm tier is not implemented yet"; it is `registry` now, and the environment's exact global restore keeps a file's DOM globals from reaching the next file. `@provino/policy`'s neutral `orchestrator.isolationDefault.byEnvironment` is empty until the realm tier exists.
- ba5e5f7: Native module mocks: a project with no dialect can `import { mock, unmock, importActual } from 'provino'`. A top-level `mock(specifier, factory?)` is hoisted above the file's imports; the factory returns the module's exports as an object (or a Promise of them) and is given `importOriginal`; no factory is an automock. `HoistPolicy` gains the optional `importedCalls` (named imports that are hoisted calls themselves) and `NativeRuntimeRefs` the optional `hoist`; both are additions no existing value has to change for. `@provino/policy` exports `nativeHoistPolicy(module)` and `NATIVE_HOISTED_CALLS`.
- 55de21e: The policy has three new keys for the Vitest dialect: `snapshot.mismatch` (when a snapshot mismatch fails the test), `core.definitions.extendApi` (whether `test.extend` is there) and `core.definitions.messages` (the module that words a definition error). `WorkerKey` gains an optional `dialect`, and `NeutralProject` gains `importMetaEnv`. The neutral policy and the Jest dialect behave as before: a mismatch fails at the end of the test, and the Jest dialect has no `test.extend`.
- Updated dependencies [28c95d9]
- Updated dependencies [5a4dce2]
- Updated dependencies [9f7b73d]
- Updated dependencies [7daea04]
- Updated dependencies [c730222]
- Updated dependencies [ba5e5f7]
- Updated dependencies [ecc8972]
- Updated dependencies [55de21e]
- Updated dependencies [c2970a6]
  - @provino/types@0.1.0-rc.7

## 0.1.0-rc.6

### Patch Changes

- @provino/types@0.1.0-rc.6

## 0.1.0-rc.5

### Patch Changes

- @provino/types@0.1.0-rc.5

## 0.1.0-rc.4

### Patch Changes

- @provino/types@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- @provino/types@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- Updated dependencies [d015c8e]
  - @provino/types@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Minor Changes

- ddb10bf: Coverage groundwork for `provino jest`: `@provino/types` gains `IstanbulFileCoverageData`, `SerializedCoverageConfig`, `RunCoverageOptions`, `CoverageThresholdGroup`, `CompiledModuleInfo`, `CoverageSummary.map`, `SerializedProjectConfig.coverage` and `NeutralProject.coverage`; the `coverage` worker event's `fileId` may be `null`; and the `coverage` policy slice gains `v8Conversion`, `v8HitCounts`, `istanbulVariable` and `thresholdMessages` (Jest's texts and values in `@provino/dialect-jest`). The transform pipeline takes an `instrumenter`. Nothing collects coverage yet.

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
