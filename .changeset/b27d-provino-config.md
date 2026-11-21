---
"provino": minor
---

`provino.config` works end to end. `defineConfig` is exported from `provino/config`. An unknown config key is an error naming the nearest known one. `timeouts`, `resolve` (`conditions`, `aliases`, `tsconfig`), package-specifier `setupFiles`, `environmentOptions`, `pool` and `maxWorkers` take effect, and `projects` (inline objects, directories, config files and globs) runs several projects in one run. `provino run` with no `--config`, and bare `provino`, use the nearest config of any kind walking up from the working directory, stopping at `.git` or `pnpm-workspace.yaml`.
