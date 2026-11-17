---
'@provino/dialect-jest': patch
'@provino/types': patch
'provino': patch
---

A test or hook that times out prints Jest's own text under `provino jest` (`CorePolicy.timeouts.message`, `FormatTimeout`, `formatTimeout`), and a worker that dies of a signal sent to the whole process group is part of the cancellation, not an error of the run.
