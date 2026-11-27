---
'provino': patch
'@provino/config': patch
'@provino/types': patch
'@provino/loader': patch
'@provino/orchestrator': patch
---

A native config takes a `define` key: compile-time replacements in the project's own modules, as a bundler's `define` makes them, so a module that reads `import.meta.env.DEV` or `process.env.NODE_ENV` runs without the runner emulating a bundler.
