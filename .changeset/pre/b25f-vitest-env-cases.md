---
"@provino/dialect-vitest": patch
"provino": patch
---

`provino vitest` resolves a project's `environment` (the config's, `--environment`) as a file's docblock is resolved, with `vitestEnvironmentRef` (now exported from `@provino/dialect-vitest/node` too): `jsdom` over the project's own jsdom, Vitest's built-in `happy-dom` and `edge-runtime`, `vitest-environment-<name>` packages and paths. `--dom` runs every file in happy-dom, as Vitest's does. The Vitest dialect keeps `jsdom` and `happy-dom` files on the `registry` isolation tier, since Vitest sets them up on the worker's own global.
