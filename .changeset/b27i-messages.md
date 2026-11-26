---
"provino": patch
"@provino/config": patch
"@provino/core": patch
"@provino/env-jsdom": patch
"@provino/env-node": patch
"@provino/loader": patch
"@provino/orchestrator": patch
---

Error and help messages no longer name internal task ids. A non-empty `plugins` or `alsoServe` says `config key "plugins" isn't supported yet`, `provino --help` no longer says that a build loads the Jest dialect's code or points at the task that builds a refused flag, and the "not implemented yet" and "not supported yet" texts of the loader, the environments, the orchestrator, core and `provino jest --watch` drop their task references.
