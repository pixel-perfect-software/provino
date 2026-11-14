---
"@provino/dialect-jest": minor
"provino": minor
---

`coverageThreshold` for `provino jest`. A run that collects coverage checks the global, path and glob groups as Jest does (a glob group file by file, negative thresholds as a cap on the uncovered count, a group no file matched as not found), prints Jest's `Jest: ...` lines on stderr after the reports and exits 1 when one is missed, with `success: false` in `--json`. The config key no longer warns that it is read but not applied.
