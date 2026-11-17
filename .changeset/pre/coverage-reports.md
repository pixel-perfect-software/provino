---
"@provino/types": minor
"@provino/dialect-jest": minor
"provino": minor
---

Coverage for `provino jest`. `--coverage`, `--collectCoverage` and the `collectCoverage` key collect coverage and write Jest's reports (`coverageReporters`, `coverageDirectory`, `collectCoverageFrom` with the files no test loaded at zero, `coveragePathIgnorePatterns`, `forceCoverageMatch`), with the text reports on stdout as Jest prints them. Both providers work: `coverageProvider: 'babel'` (Istanbul) and `'v8'`. `coverageThreshold` is checked as Jest checks it, and a miss prints Jest's `Jest: …` lines and exits 1. Workers and shards merge into one report, and `--json`'s results carry `coverageMap`.

`RunSummary.coverage` holds a run's merged coverage, moved back to the sources, and `CoverageSummary.untestedFailures` the files no test loaded whose coverage could not be made. The Jest dialect's `/node` entry adds `jestCoverageFilter`, `jestCoverageOptions` and `jestCoverageTexts`, and `AggregatedResult.coverageMap`.
