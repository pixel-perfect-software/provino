# Vendored upstream: Vitest's `.each` title formatting

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © 2021-Present VoidZero Inc. and Vitest contributors; the pretty-format files keep their Meta Platforms header)
- **Tag:** `v5.0.5`, commit `7a825db43e2beca0b219d2eadaec334cb81af0c7` (DECISIONS S3; `git ls-remote https://github.com/vitest-dev/vitest refs/tags/v5.0.5`, 2026-11-06)
- **Copied:** 2026-11-08, from the clone in `.refs/vitest`
- **Compiled as its own `tsc -b` project** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` off (DECISIONS D17), and with the DOM libs, because the pretty-format plugins name DOM types. Biome skips this directory, so upstream formatting stays and a diff against a newer tag stays readable.
- **No runtime dependencies.** `@vitest/pretty-format` is vendored here rather than depended on, so this package takes nothing it did not have. `tinyrainbow` and `react-is` are not copied (see below).
- Vitest 5.0 has no `@vitest/runner` package: `formatTitle` lives in the `vitest` package's runner.

## Files

| File here | Source (`packages/`) | How |
|---|---|---|
| `runner/title.ts` | `vitest/src/runtime/runner/suite.ts` L980-L1074 | extracted: `formatTitle` and `handleRegexMatch`, bodies unchanged except patch 3 |
| `utils/display.ts` | `utils/src/display.ts` | copied, patched: `format`, `inspect`, `stringify`, `truncateString`, `formatRegExp` |
| `utils/helpers.ts` | `utils/src/helpers.ts` L129-L141, L235-L246, L313-L323; `utils/src/types.ts` L2-L3 | extracted: `toArray`, `isObject`, `objectAttr`, `isNegativeNaN` and the `Nullable` and `Arrayable` types, bodies unchanged |
| `pretty-format/index.ts`, `collections.ts`, `types.ts` | `pretty-format/src/` | copied, patched |
| `pretty-format/plugins/{AsymmetricMatcher,DOMCollection,DOMElement,Immutable,ReactTestComponent}.ts`, `plugins/lib/{markup,escapeHTML}.ts` | `pretty-format/src/plugins/` | copied (the `.ts` extension on imports is the only change) |

Not copied: `formatTemplateString` (core turns a tagged template into rows), the rest of `@vitest/utils` (`helpers.ts` and the other entries), and the `ReactElement` plugin.

## Local patches

Every patch except the first is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution), in every file that has a relative import. Not marked line by line.
2. **`display.ts` imports `../pretty-format/index.ts`** instead of `@vitest/pretty-format`, and drops `ReactElement` from its plugin lists.
3. **`title.ts` takes `taskTitleValueFormatTruncate` as a parameter** instead of reading `runner.config`, is exported, and has a return type for isolatedDeclarations. The formatter is called with 40, Vitest's default.
4. **`pretty-format/index.ts` has no tinyrainbow.** `styles` is an empty object: only `highlight` reads it, which no title sets, and with no styles `getColorsHighlight` throws upstream's own error.
5. **`pretty-format/index.ts` has no `ReactElement` plugin**, and `plugins/ReactElement.ts` is not copied, because it needs `react-is` and `react-is-18`. A React element in a `.each` row therefore prints as the plain object it is, where Vitest prints it as markup. (`ReactTestComponent`, `DOMElement`, `DOMCollection`, `Immutable` and `AsymmetricMatcher` are all here.)
