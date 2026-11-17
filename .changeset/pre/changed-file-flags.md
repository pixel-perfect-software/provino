---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": patch
---

`provino jest` runs the changed-file flags: `-o`/`--onlyChanged`, `--changedSince`, `--lastCommit`, `--changedFilesWithAncestor`, `--findRelatedTests` and `--onlyFailures`/`-f`, which were refused. They select the files Jest 30.5.2 selects (git, hg and Sapling, Jest's own commands; the dependency graph by haste's extractor; the failed files from the results history), for a run and for `--listTests`, with Jest's no-tests texts and exit codes. A project's own `dependencyExtractor` is applied, with haste's extractor as its fallback; `DependencyExtractor`'s `fallback` returns a `Set<string>`, as jest-haste-map's does, so an extractor may add to it.

`@provino/dialect-jest/affected` now holds the working provider (`jestChangedFiles`) and extractor (`jestDependencyExtractor`), and `@provino/dialect-jest/node` gains `jestChangedNoTestsMessage`, `jestChangedFilesErrorText` and `JEST_NO_SCM_TEXT`.
