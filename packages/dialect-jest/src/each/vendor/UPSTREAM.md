# Vendored upstream: jest-each's title formatting

- **Repository:** https://github.com/jestjs/jest (MIT, © Meta Platforms, Inc. and affiliates)
- **Tag:** `v30.5.2`, commit `202dd8a14777c270607c2416bd5034c3c0abc984` (DECISIONS S3)
- **Copied:** 2026-11-08, from the clone in `.refs/jest`
- **Compiled as its own `tsc -b` project** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` off (DECISIONS D17). Biome skips this directory, so upstream formatting stays and a diff against a newer tag stays readable.
- **Runtime dependencies,** pinned to what `jest-each@30.5.2` depends on: `@jest/get-type` 30.5.0 (`isPrimitive`) and `pretty-format` (30.5.1 is what `jest-each@30.5.2` resolves; the catalog pins it). `jest-regex-util` and `chalk` are not dependencies here (see below).

## Files

| File here | Source (`packages/jest-each/src/`) | How |
|---|---|---|
| `jest-each/array.ts` | `table/array.ts` | copied, patched. `array()` (the whole-table entry) is kept as upstream has it; Provino titles one row at a time through the now-exported `formatTitle` |
| `jest-each/interpolation.ts` | `table/interpolation.ts` | copied, patched. `interpolateVariables` is what titles a tagged-template row and an array of objects |
| `jest-each/escapeStrForRegex.ts` | `jest-regex-util` 30.5.0, `src/index.ts` | extracted: `escapeStrForRegex`, body unchanged |
| `jest-each/types.ts` | `@jest/types` 30.5.2 `Global.ts` (`Col`, `Row`, `Table`, `ArrayTable`) and `jest-each`'s `bind.ts` (`EachTests`) | **Provino's own file**, type declarations only, standing in for the two sources `array.ts` imports types from |

Not copied: `bind.ts` and `index.ts` (the `.each` binding, which `@provino/core` replaces), `table/template.ts` (it turns a tagged template into one object per row and calls `interpolateVariables(title, row, index)`; core builds the rows, so the call is the glue's) and `validation.ts` (the errors for a bad table, which `collect.eachTableError` and core's messages own).

## Local patches

Every patch is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution), in `array.ts` and `interpolation.ts`.
2. **`array.ts` imports its types from `./types.ts`** instead of `@jest/types` and `../bind`.
3. **`array.ts` exports** `SUPPORTED_PLACEHOLDERS`, `PLACEHOLDER_PREFIX`, `ESCAPED_PLACEHOLDER_PREFIX`, `formatTitle` and `interpolateEscapedPlaceholders`, so `../../format-each-title.ts` can title one row. No code changed.
4. **`interpolation.ts` imports `escapeStrForRegex` from `./escapeStrForRegex.ts`** instead of `jest-regex-util`.
5. **`isolatedDeclarations` annotations** in `array.ts`: `SUPPORTED_PLACEHOLDERS: RegExp` and the return type of `interpolateEscapedPlaceholders`.

## Not reproduced

- **`SUPPORTED_PLACEHOLDERS` is a global regex, and upstream's `isTemplates` calls `.test()` on it**, so its `lastIndex` survives into the next table. After a table whose rows are all empty (nothing resets it), the next table's `isTemplates` starts part-way into its title. Provino's glue tests the title with the index reset, as every other table does.
