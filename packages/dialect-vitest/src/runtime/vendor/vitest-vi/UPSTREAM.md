# Vendored upstream: Vitest's `vi.when`, `vi.waitFor` and `vi.waitUntil`

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © 2021-Present VoidZero Inc. and Vitest contributors)
- **Tag:** `v5.0.5`, commit `7a825db43e2beca0b219d2eadaec334cb81af0c7` (DECISIONS S3)
- **Copied:** 2026-11-20, from the clone in `.refs/vitest` (B25f, T11.16)
- **Compiled as its own `tsc -b` project** (`tsconfig.json` here), with the same options off as `../vitest-expect` (D17). Biome skips the directory (`!**/vendor`).

## Files

| File here | Source | How |
|---|---|---|
| `when.ts` | `packages/vitest/src/integrations/mock/when.ts` | copied (1, 2) |
| `wait.ts` | `packages/vitest/src/integrations/wait.ts` | copied, patched (1, 2, 3) |
| `types.ts` | none | Provino's stand-ins for the types the two files import, and `@vitest/spy`'s `isMockFunction` (upstream's own body, `packages/spy/src/index.ts` L17-L19) |

## Local patches

1. **`.ts` on relative imports.** Not marked line by line.
2. **Package imports point at the copies**: `@vitest/expect` at `../vitest-expect/`, `@vitest/utils/*` at `src/vendor/vitest-utils/`, `@vitest/spy` at `types.ts`. Not marked line by line.
3. **`wait.ts`: `createWait(vi, timers)`** makes the two functions over the `vi` and the real timers it is given, where upstream imports its one `vi` and calls `getSafeTimers()` (marked `// provino:`). The bodies are unchanged.
