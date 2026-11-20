---
"@provino/dialect-vitest": patch
"provino": patch
---

The Vitest dialect's globals and `vi`: `vitestGlobals` builds the 19 globals Vitest injects, `vitestModuleScope` gives each module its own `vi` (Vitest 5.0.5's members, in its order) and serves `vitest`, `@vitest/expect`, `@vitest/spy` and `vitest/runtime`.
