# Vendored upstream: Jest's `@jest/expect-utils`

- **Repository:** https://github.com/jestjs/jest (MIT, © Meta Platforms, Inc. and affiliates)
- **Tag:** `v30.5.2`, commit `202dd8a14777c270607c2416bd5034c3c0abc984` (DECISIONS S3)
- **Copied:** 2026-11-20, from the clone in `.refs/jest` (B27c, D187, `compat`: the algorithm the Jest table already uses, so `toEqual` means what users know; the faster option would be a hand-written equality, which would change what `toEqual` accepts)
- **Compiled as its own `tsc -b` project** (`tsconfig.json` here, the flags of Jest's own build, D17). Biome skips the directory.
- **No runtime dependency.** `@jest/get-type`'s one used function is inlined (patch 2).

## Files

| File here | Source (`packages/expect-utils/src/`) | How |
|---|---|---|
| `jasmineUtils.ts` (`equals`, `isA`), `utils.ts` (`iterableEquality`, `subsetEquality`, `typeEquality`, `sparseArrayEquality`, `arrayBufferEquality`, `getPath`, `emptyObject`, and the rest), `immutableUtils.ts`, `types.ts`, `index.ts` | the same names | copied (1), `utils.ts` also (2) |

Not copied: `__tests__/`. `equals.test.ts` (in `../../`) holds the copy to the real `@jest/expect-utils` 30.5.2, a devDependency, over a seeded table.

## Local patches

1. **`.ts` on relative imports** (Node ESM resolution). Not marked line by line.
2. **`isPrimitive`** from `@jest/get-type` 30.5.0 (`Object(value) !== value`) is defined in `utils.ts`, marked `// provino:`.
