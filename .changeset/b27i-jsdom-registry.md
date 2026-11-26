---
"provino": patch
"@provino/policy": patch
---

A project with `environment: 'jsdom'` or `'happy-dom'` and no `isolation` now runs: the default tier for them is `registry`, like every other environment, where it was the `realm` tier, which is not built, so every file failed with "the realm tier is not implemented yet". The environment's exact global restore keeps a file's DOM globals from reaching the next file. `@provino/policy`'s neutral `orchestrator.isolationDefault.byEnvironment` is empty, so the Jest dialect, which inherits it, resolves to `registry` for every environment as well.
