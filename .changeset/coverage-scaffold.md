---
"@provino/types": minor
"@provino/policy": minor
"@provino/dialect-jest": minor
"@provino/dialect-vitest": minor
"@provino/transform": minor
---

Coverage groundwork for `provino jest`: `@provino/types` gains `IstanbulFileCoverageData`, `SerializedCoverageConfig`, `RunCoverageOptions`, `CoverageThresholdGroup`, `CompiledModuleInfo`, `CoverageSummary.map`, `SerializedProjectConfig.coverage` and `NeutralProject.coverage`; the `coverage` worker event's `fileId` may be `null`; and the `coverage` policy slice gains `v8Conversion`, `v8HitCounts`, `istanbulVariable` and `thresholdMessages` (Jest's texts and values in `@provino/dialect-jest`). The transform pipeline declares an `instrumenter` option that nothing reads yet (`instrument: true` is still refused). Nothing collects coverage yet.
