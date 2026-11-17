---
"provino": patch
"@provino/types": patch
---

`provino jest -o --coverage` counts only the changed files and the sources the changed test files import, as Jest does. `SerializedCoverageConfig` gains `changedFiles` and `sourcesRelatedToTestsInChangedFiles`.
