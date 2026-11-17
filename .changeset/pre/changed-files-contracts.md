---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

Contracts for changed-file and affected-test selection (the groundwork for `--onlyChanged`, `--findRelatedTests` and `--watch` under `provino jest`; nothing selects by them yet). `@provino/types` gains `ChangedFiles`, `ChangedFilesOptions`, `ChangedFilesProvider`, `DependencyExtractor`, `DependencyExtractorFactory` and `AffectedSelection`; `OrchestratorPolicy` gains `changedFiles` and `affected` (`extractor`, `mockEdges`, `invalidateAll`, `graph`); `FileJob` gains `staleModules`; `Loader` gains `dropRecords`; `NeutralProject` gains `watch` and `affected`. `@provino/dialect-jest` adds the `@provino/dialect-jest/affected` entry, whose `jestChangedFiles` and `jestDependencyExtractor` throw `ORCH_NOT_IMPLEMENTED` until they are built.
