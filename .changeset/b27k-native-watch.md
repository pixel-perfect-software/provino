---
"provino": patch
---

`provino run --watch` and `--watchAll` (and the bare `provino --watch` in a project with a `provino.config.*`): the first run is every file, then a change reruns the test files it reaches (every file for `--watchAll`, or for a change to a `package.json`, `provino.config.*` or tsconfig). On a terminal, `a` runs all, `f` the failed, Enter the last run again and `q` quits, with a hint line after each run; off a terminal it reruns on change with no keys. `--coverage` is refused by name, with or without `--watch`, as are `--shard` and `--detectOpenHandles` with it. `provino --help` lists the flags and keys.
