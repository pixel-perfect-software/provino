# Vendored upstream: Vitest's built-in `happy-dom` and `edge-runtime` environments

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © 2021-Present VoidZero Inc. and Vitest contributors)
- **Tag:** `v5.0.5`, commit `7a825db43e2beca0b219d2eadaec334cb81af0c7` (DECISIONS S3)
- **Copied:** 2026-11-20, from the clone in `.refs/vitest` (B25f, T8.6)
- **Compiled as its own `tsc -b` project** (`tsconfig.json` here), with the same options off as `../vitest-vi` plus `noImplicitAny` (D17). Biome skips the directory (`!**/vendor`).

## Files

| File here | Source | How |
|---|---|---|
| `happy-dom.ts` | `packages/vitest/src/integrations/env/happy-dom.ts` | copied, patched (1, 2, 3, 4) |
| `edge-runtime.ts` | `packages/vitest/src/integrations/env/edge-runtime.ts` | copied, patched (1, 2, 3, 4) |
| `types.ts` | none | Provino's stand-ins for the types the two files import, and the deps they are given |

## Local patches

1. **`.ts` on relative imports.** Not marked line by line.
2. **The imports are parameters** (marked `// provino:`): each module exports a factory over `SetupDeps` (`populateGlobal` and `KEYS` are `@provino/env-shared`'s copies of `./utils` and `./jsdom-keys`, so the package keeps one), and the library (`happy-dom`, `@edge-runtime/vm`) is the project's own, through `load`, where upstream imports Vitest's peer.
3. **`setupVM` is left out**: the `context` realm waits for T2.8, and the adapter refuses an environment with only `setupVM`.
4. **`setup` also returns `populated`** (marked `// provino:`), so the worker hears the populated keys being read (D127) without redefining them. The teardowns are unchanged.
