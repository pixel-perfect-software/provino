# @provino/transform

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

- 6002b7a: A syntax error in a module the loader runs is a `SyntaxError`, as Node gives it, with the parser's message and position, and the transform's error as its `cause`. `TransformError.parse` says when a transform failure is the parser's report of a syntax error.
- ce31acb: Error and help messages no longer name internal task ids. A non-empty `plugins` or `alsoServe` says `config key "plugins" isn't supported yet`; `provino --help` no longer says that a build loads the Jest dialect's code or points at the task that builds a refused flag; and the "not implemented yet", "not supported yet" and "not applied" texts of `provino run`, `provino jest` and `provino vitest`, the loader, the environments, core, the orchestrator, coverage, the transform and the inline snapshot matchers drop their task and decision references.
- ba5e5f7: Native module mocks: a project with no dialect can `import { mock, unmock, importActual } from 'provino'`. A top-level `mock(specifier, factory?)` is hoisted above the file's imports; the factory returns the module's exports as an object (or a Promise of them) and is given `importOriginal`; no factory is an automock. `HoistPolicy` gains the optional `importedCalls` (named imports that are hoisted calls themselves) and `NativeRuntimeRefs` the optional `hoist`; both are additions no existing value has to change for. `@provino/policy` exports `nativeHoistPolicy(module)` and `NATIVE_HOISTED_CALLS`.
- 5713e8e: A source map from oxc-transform 0.159, which can list a source as `undefined`, is written with `null` there, as a v3 map has it.
- 30b872f: The Vite bridge and plugin host. `@provino/dialect-vitest/vite-bridge` runs the project's own `vitest/node` `resolveConfig` when a Vitest config has plugins (every plugin's `config` and `configResolved` hook runs) and reads `test`, the JSX settings, the defines and the user's plugins, with a version and a code hash each; without Vite installed it warns once and skips the plugins. `@provino/transform/vite` hosts those plugins' `buildStart`, `resolveId`, `load` and `transform` hooks with a plugin context (`parse`, `resolve`, `warn`, `error`, `addWatchFile`, `getCombinedSourcemap`, `environment`); `\0` and query ids are virtual modules the host owns, `@vitejs/plugin-react` is skipped, and a dev-server hook or `this.getModuleInfo` fails with `VITE_HOOK_UNSUPPORTED` naming the plugin. `vite` is an optional peer of `@provino/transform`. `provino vitest` itself is still not available.
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

- a9571da: `TransformErrorCode` gains `COVERAGE_INSTRUMENT_FAILED`: a file the coverage instrumenter cannot read comes back with that error diagnostic and its code unchanged, on a transformer's files as on the Oxc path (a file that already has an error diagnostic is not instrumented). A request with `instrument: true` and no `instrumenter` is `TRANSFORM_OPTION_UNSUPPORTED` for a transformer's file too, unless the transformer reports `canInstrument`.
- a9571da: The transform pipeline runs a coverage instrumenter. A request with `instrument: true` is instrumented after TypeScript is stripped (or after the project's transformer, unless it reports `canInstrument` and was given `instrument: true`) and before the hoister, with the map the earlier steps composed; the instrumenter's `name` is part of the cache fingerprint. `HostedSource` gains `canInstrument`. A request with `instrument: true` and no `instrumenter` is still `TRANSFORM_OPTION_UNSUPPORTED`.
- ddb10bf: Coverage groundwork for `provino jest`: `@provino/types` gains `IstanbulFileCoverageData`, `SerializedCoverageConfig`, `RunCoverageOptions`, `CoverageThresholdGroup`, `CompiledModuleInfo`, `CoverageSummary.map`, `SerializedProjectConfig.coverage` and `NeutralProject.coverage`; the `coverage` worker event's `fileId` may be `null`; and the `coverage` policy slice gains `v8Conversion`, `v8HitCounts`, `istanbulVariable` and `thresholdMessages` (Jest's texts and values in `@provino/dialect-jest`). The transform pipeline takes an `instrumenter`. Nothing collects coverage yet.
- 26ed357: TypeScript on the coverage path is stripped in place (D116): a `.ts`, `.mts` or `.cts` file requested with `instrument: true` has its type syntax overwritten with spaces, so every token keeps its offset and the instrumenter gets no input map, and Istanbul's statement, function and branch maps equal Jest's babel provider. A file with an enum, a namespace with values, a parameter property, `import x =`, `export =`, a decorator under `experimentalDecorators` or a class field under `useDefineForClassFields: false`, a `.tsx` file, and any file under `define` keep Oxc's transform and its map. `SerializedLoaderConfig.typescript` and the pipeline's `typescript` option gain `'blank'`, which strips every erasable TypeScript file that way.

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
