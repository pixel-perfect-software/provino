---
"provino": patch
"@provino/policy": patch
"@provino/transform": patch
"@provino/types": patch
---

Under `globals: true`, a `mock()` at the top of the global `isolateModules` or `isolateModulesAsync` callback is hoisted to the top of that callback, as it is with the imported functions (`mock` itself is still imported from `provino`, and only the bare call `isolateModules(…)` counts, not `globalThis.isolateModules(…)`), instead of failing the file with `HOIST_NOT_TOP_LEVEL`. `HoistPolicy` gains the optional `globalCallbackScopes`.
