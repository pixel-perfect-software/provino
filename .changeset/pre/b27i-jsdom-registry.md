---
"provino": patch
"@provino/policy": patch
---

A native project (no dialect) with `environment: 'jsdom'` and no `isolation` now runs under `provino run`. Its default tier was `realm`, which is not built, so every file failed with "the realm tier is not implemented yet"; it is `registry` now, and the environment's exact global restore keeps a file's DOM globals from reaching the next file. `@provino/policy`'s neutral `orchestrator.isolationDefault.byEnvironment` is empty until the realm tier exists.
