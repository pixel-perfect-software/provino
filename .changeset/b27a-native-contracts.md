---
"@provino/types": patch
"@provino/config": patch
"provino": patch
---

The contracts for Provino-native projects (B27, D184 to D186). `ProvinoConfigInput` gains `timeouts`, `resolve` (`conditions`, `aliases`, `tsconfig`), `environmentOptions`, and the run keys `pool` and `maxWorkers`; `setupFiles` may name a package. `ProvinoConfig` is what `defineConfig` will take. These are types only for now: a later release reads them. `NativeRuntimeRefs` and `ResolveProjectOptions.native` carry the native runtime's matcher table, served modules and globals for a project with no dialect.
