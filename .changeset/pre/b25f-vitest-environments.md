---
"@provino/dialect-vitest": patch
"provino": patch
---

The Vitest dialect's environments: `node`, `jsdom` (over the project's own jsdom), Vitest's built-in `happy-dom` and `edge-runtime` setups over the project's libraries, `vitest-environment-<name>` packages and paths, and the `@vitest-environment` and `@jest-environment` docblocks with their options. An externalized package that registers a hook or writes the global as it loads is evaluated again in each file, as Vitest's isolated files do.
