---
'provino': patch
'@provino/types': minor
---

A worker compiles its modules' wrapper scripts from V8's code cache when an earlier run left it, so the first test file of each worker no longer parses and compiles the shared `node_modules` graph again, and the functions that file ran come back compiled too. The cache lives in the transform cache's directory (`node_modules/.cache/provino/t/v8`), as packs: each worker reads a pack's index once and one entry per script. It is keyed by each script's text, filename and offset, and by V8's version and flags; a damaged entry is compiled from its source and rewritten; the coordinator merges the packs after a run that wrote some, and the transform cache's pruning and lockfile wipe cover them. It is off under `--no-cache` and under coverage. `LoaderOptions.codeCache` names its directory.
