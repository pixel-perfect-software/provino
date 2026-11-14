---
"@provino/types": minor
"@provino/dialect-jest": minor
"provino": patch
---

Coverage under `provino jest` follows Jest 30.5.2 more closely. With Jest's default babel-jest transform, only the files under the process's working directory are instrumented, as babel-jest's `cwd` does (`cd packages/a && jest` with `rootDir: '../..'`). Every coverage entry carries Istanbul's own `_coverageSchema`, the value Jest writes. A source that is not on disk but whose source map carries its text is shown in the reports from that text. A run without coverage loads none of the coverage code.

`SerializedCoverageConfig.instrumentRoot` is the root Istanbul instruments within when it is not `projectRoot`, `CoverageSummary.sources` holds the text of sources not on disk, and `jestCoverageFilter` takes `{ babelInstruments }`.
