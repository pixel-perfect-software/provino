# @provino/transform

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
