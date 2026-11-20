# Vendored upstream: Vitest's `@vitest/utils`

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © 2021-Present VoidZero Inc. and Vitest contributors; the `diff/` files keep the Meta Platforms header they were forked from Jest with)
- **Tag:** `v5.0.5`, commit `7a825db43e2beca0b219d2eadaec334cb81af0c7` (DECISIONS S3)
- **Copied:** 2026-11-19, from the clone in `.refs/vitest` (B25b, T7.6)
- **The package's one copy** of `@vitest/utils`: the expect table (`src/runtime/vendor/vitest-expect/`) and the `.each` titles (`src/each/vendor/`) import it. It prints with the package's one `@vitest/pretty-format` (`../pretty-format/`).
- **Compiled as its own `tsc -b` project** (`tsconfig.json` here, the expect table's flags, D17). Biome skips the directory.
- **No runtime dependency.** `@vitest/utils`' two, `@vitest/pretty-format` and `tinyrainbow`, are the copies beside it and here; `convert-source-map` is only used by entries not copied.

## Files

| File here | Source | How |
|---|---|---|
| `display.ts` | `packages/utils/src/display.ts` | copied, patched (1, 2, 3) |
| `helpers.ts`, `constants.ts`, `types.ts`, `error.ts`, `serialize.ts`, `nanoid.ts`, `random.ts` | `packages/utils/src/` | copied (1, 2) |
| `diff/*.ts` | `packages/utils/src/diff/` | copied (1, 2; `index.ts` also 3) |
| `diff-sequences.ts` | Jest v30.5.2 (https://github.com/jestjs/jest), `packages/diff-sequences/src/index.ts` | copied unchanged: `@vitest/utils` bundles diff-sequences (`^29.6.3`, the same algorithm) |
| `tinyrainbow.ts` | tinyrainbow 3.2.0, `dist/index.js` (the npm tarball `@vitest/utils` 5.0.5 installs; tinyrainbow has no `.refs` clone) | ported to TypeScript: the same colour test and escape pairs, the names spelled out; left out, since nothing copied here calls them: `rgb`, `bgRgb`, `hex`, `bgHex`, `disableDefaultColors` and `enabledDefaultColors` |

Not copied: the entries the expect table and the titles don't import (`offset`, `resolver`, `source-map`, `timers`, `index`).

## Local patches

Every patch except the first two is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution). Not marked line by line.
2. **Package imports point at the copies**: `@vitest/pretty-format` at `../pretty-format/index.ts`, `tinyrainbow` and `diff-sequences` at the files here. Not marked line by line.
3. **No `ReactElement` plugin** in `display.ts`'s and `diff/index.ts`'s plugin lists (it needs `react-is`); the one `@vitest/pretty-format` copy doesn't have it either.
