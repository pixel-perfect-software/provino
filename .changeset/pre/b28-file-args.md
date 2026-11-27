---
'provino': patch
---

`provino run` and the bare `provino` take test path patterns: `provino run math src/a.test.ts` runs the files whose path matches any of them (case-insensitive regular expressions, as Jest's path patterns are). A word that is not a command is a pattern for the bare form, a pattern that matches no file is named, and `--watch` keeps every rerun inside the patterns. `RunOptions` gains `testPathPatterns`.
