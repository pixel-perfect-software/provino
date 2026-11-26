---
'@provino/types': patch
'@provino/config': patch
provino: patch
---

A native `provino.config.*` takes a top-level `execArgv`: the Node flags each forked or threaded worker starts with (`['--conditions=provino-source']`), added after the coordinator's own. It is top level only (a project in `projects` refuses it), and an `inline` pool or an in-band run ignores it.
