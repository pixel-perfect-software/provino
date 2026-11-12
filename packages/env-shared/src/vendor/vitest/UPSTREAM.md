# Vendored upstream: Vitest's DOM key list

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © Vitest contributors)
- **Tag:** `v5.0.5`, commit `7a825db4` (DECISIONS S3)
- **Copied:** 2026-11-12, from `.refs/vitest`

| File here | Source | How |
|---|---|---|
| `jsdom-keys.ts` | `packages/vitest/src/integrations/env/jsdom-keys.ts` | copied unchanged: the keys jsdom's interfaces and window add |

`populate.ts` (one directory up) is our code, written to `populateGlobal`'s semantics in
`packages/vitest/src/integrations/env/utils.ts` (see its header for the two differences).
