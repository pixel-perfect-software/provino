---
"@provino/dialect-vitest": patch
"@provino/resolver": patch
"provino": patch
---

The Vitest config reader: `@provino/dialect-vitest/node` finds `vitest.config.*` or `vite.config.*`, imports it natively (`vitest/config` is served by a stand-in, so reading a config loads neither Vitest nor Vite), applies `test` over Vitest's defaults and the command line over the file, resolves `test.projects` and the `.env*` files, and returns neutral projects; a config with plugins is marked for the Vite bridge. `@provino/resolver` gains `viteAliasMapper`, Vite's `resolve.alias` rule. Bare `provino` now detects a `vite.config.*` with a `test` key as a Vitest project. `provino vitest` itself is still not available.
