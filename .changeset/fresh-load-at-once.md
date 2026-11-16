---
"provino": patch
"@provino/config": patch
"@provino/dialect-jest": patch
---

`provino jest --projects a b` (or a config's `projects`) no longer fails with Node's `ERR_INTERNAL_ASSERTION` when the projects share a CommonJS custom `resolver`, such as `ts-jest-resolver`. The Jest dialect loads what a Jest config names as jest-util's `requireOrImportModule` does: a plain `require` (an `import()` for `.mjs`/`.mts`, or when `require` refuses an ES module), so a config, reporter, watch plugin or results processor loads once per process, and a custom resolver is loaded once per process by its real path and shared by every project, as jest-resolve's `preloadedResolvers` is. A preset is still read afresh for each project, as Jest deletes it from `require.cache` first. Before, each project imported the resolver afresh at the same time, and a second fresh load of a CommonJS file removed its entry from Node's module cache while Node was still loading the first.

A resolver that throws as it loads is `JEST_CONFIG_RESOLVER_LOAD_FAILED`, with a message that names the resolver and the first line of what it threw, and what it threw as the `cause`, and `provino jest` prints that error's stack, as jest-cli does. `@provino/config` no longer exports `importConfigModule` (only `loadConfigFile` called it, and its `withoutDefault` option, which served Jest's resolver, is gone): the `provino.config.*` loader runs fresh loads of one file (by its real path) one after another, so two runs that overlap on one config can't meet the same assertion.
