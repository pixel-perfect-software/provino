---
"provino": patch
"@provino/config": patch
"@provino/core": patch
"@provino/coverage": patch
"@provino/dialect-jest": patch
"@provino/dialect-vitest": patch
"@provino/env-jsdom": patch
"@provino/env-node": patch
"@provino/expect": patch
"@provino/loader": patch
"@provino/orchestrator": patch
"@provino/transform": patch
---

Error and help messages no longer name internal task ids. A non-empty `plugins` or `alsoServe` says `config key "plugins" isn't supported yet`; `provino --help` no longer says that a build loads the Jest dialect's code or points at the task that builds a refused flag; and the "not implemented yet", "not supported yet" and "not applied" texts of `provino run`, `provino jest` and `provino vitest`, the loader, the environments, core, the orchestrator, coverage, the transform and the inline snapshot matchers drop their task and decision references.
