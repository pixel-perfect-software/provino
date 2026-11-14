---
"@provino/types": minor
"@provino/dialect-jest": minor
"provino": minor
---

Coverage reports for `provino jest`. `--coverage`, `--collectCoverage` and the `collectCoverage` key now collect Istanbul coverage and write Jest's reports (`coverageReporters`, `coverageDirectory`, `collectCoverageFrom` with the files no test loaded at zero, `coveragePathIgnorePatterns`, `forceCoverageMatch`), with the text reports on stdout as Jest prints them. `--json`'s results carry `coverageMap`. Jest's `v8` provider is read but not applied yet, with a warning.

`RunSummary.coverage` holds a run's merged coverage, moved back to the sources, and `CoverageSummary.untestedFailures` the files no test loaded whose coverage could not be made. The Jest dialect's `/node` entry adds `jestCoverageFilter`, `jestCoverageOptions` and `jestCoverageTexts`, and `AggregatedResult.coverageMap`.
