---
"@provino/dialect-vitest": patch
"@provino/transform": patch
"provino": patch
---

The Vite bridge and plugin host. `@provino/dialect-vitest/vite-bridge` runs the project's own `vitest/node` `resolveConfig` when a Vitest config has plugins (every plugin's `config` and `configResolved` hook runs) and reads `test`, the JSX settings, the defines and the user's plugins, with a version and a code hash each; without Vite installed it warns once and skips the plugins. `@provino/transform/vite` hosts those plugins' `buildStart`, `resolveId`, `load` and `transform` hooks with a plugin context (`parse`, `resolve`, `warn`, `error`, `addWatchFile`, `getCombinedSourcemap`, `environment`); `\0` and query ids are virtual modules the host owns, `@vitejs/plugin-react` is skipped, and a dev-server hook or `this.getModuleInfo` fails with `VITE_HOOK_UNSUPPORTED` naming the plugin. `vite` is an optional peer of `@provino/transform`. `provino vitest` itself is still not available.
