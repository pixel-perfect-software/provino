# @provino/policy

## 0.1.0-rc.12

### Patch Changes

- 22f6272: Work a native jsdom file left queued no longer fails its last test with `window is not defined`. When the file's window is about to close, the worker runs the file's pending `setImmediate` and 0 ms `setTimeout` work while the window is still there (at most 50 turns or 50 ms), so a React commit that lands as the test ends runs, and React's scheduler still works in the next files. Then it clears the file's `setImmediate` and `setTimeout` work that is still pending, so none of it fires into the next file. Intervals and message ports are left alone, since a package shared by the worker's files may keep them. The new policy key is `orchestrator.windowFileWork` (`drain-then-cancel` for native projects, `outlives-file` for the Jest and Vitest dialects, which keep their behaviour). A timer cleared by its numeric id or through `node:timers` no longer holds up the wait, and a timeout that fired and was `refresh()`ed is still cleared. The default reporter now prints a dependency's stack frames for an error whose every frame is a dependency's or Node's, where it used to print none; where the error happened (a GitHub Actions annotation, the `provino` reporter's location) still comes from the user's own frames only.
- Updated dependencies [22f6272]
  - @provino/types@0.1.0-rc.12

## 0.1.0-rc.11

### Patch Changes

- bb82b45: A native project takes `expect(value, message)` and `expect.soft(value, message)`: the message is the first line of a failure, then a blank line, then the matcher's text with the measured values. A third argument is refused as "expect() takes a value and an optional message".
- cfb5974: A native project can import an asset or a style file. `import logo from './logo.svg'` is the file's URL as a Vite dev server writes it (`/src/logo.svg`, or `/@fs/<path>` outside the project root), a `.css` or `.scss` import is an empty module, and a `*.module.css` import is an object that answers each name with itself. `?raw` imports the file's text and `?url` its URL. A `mock()` of the file still wins, so does a transform the project configures for it, and a dependency's own asset or stylesheet import works too. Projects on the Jest or Vitest dialect are unchanged.
- Updated dependencies [514f338]
- Updated dependencies [bb82b45]
- Updated dependencies [8660a21]
- Updated dependencies [cfb5974]
  - @provino/types@0.1.0-rc.11

## 0.1.0-rc.10

### Patch Changes

- 43cab28: Under `globals: true`, a `mock()` at the top of the global `isolateModules` or `isolateModulesAsync` callback is hoisted to the top of that callback, as it is with the imported functions (`mock` itself is still imported from `provino`, and only the bare call `isolateModules(…)` counts, not `globalThis.isolateModules(…)`), instead of failing the file with `HOIST_NOT_TOP_LEVEL`. `HoistPolicy` gains the optional `globalCallbackScopes`.
- Updated dependencies [43cab28]
- Updated dependencies [921fde7]
  - @provino/types@0.1.0-rc.10

## 0.1.0-rc.9

### Patch Changes

- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
  - @provino/types@0.1.0-rc.9

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
