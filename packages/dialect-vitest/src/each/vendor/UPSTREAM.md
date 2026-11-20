# Vendored upstream: Vitest's `.each` title formatting

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © 2021-Present VoidZero Inc. and Vitest contributors)
- **Tag:** `v5.0.5`, commit `7a825db43e2beca0b219d2eadaec334cb81af0c7` (DECISIONS S3; `git ls-remote https://github.com/vitest-dev/vitest refs/tags/v5.0.5`, 2026-11-06)
- **Copied:** 2026-11-08, from the clone in `.refs/vitest`
- **Compiled as its own `tsc -b` project** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` off (DECISIONS D17). Biome skips this directory, so upstream formatting stays and a diff against a newer tag stays readable.
- **One copy of `@vitest/utils` and `@vitest/pretty-format`** (B25b): `format`, `inspect` and the helpers come from the package's vendored `@vitest/utils` (`src/vendor/vitest-utils/`), which prints with its one `@vitest/pretty-format` (`src/vendor/pretty-format/`). This directory had its own copies of both until then.
- Vitest 5.0 has no `@vitest/runner` package: `formatTitle` lives in the `vitest` package's runner.

## Files

| File here | Source (`packages/`) | How |
|---|---|---|
| `runner/title.ts` | `vitest/src/runtime/runner/suite.ts` L980-L1074 | extracted: `formatTitle` and `handleRegexMatch`, bodies unchanged except patch 3 |

Not copied: `formatTemplateString` (core turns a tagged template into rows).

## Local patches

Every patch except the first is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution). Not marked line by line.
2. **`title.ts` imports `display.ts` and `helpers.ts` from `src/vendor/vitest-utils/`** instead of `@vitest/utils`.
3. **`title.ts` takes `taskTitleValueFormatTruncate` as a parameter** instead of reading `runner.config`, is exported, and has a return type for isolatedDeclarations. The formatter is called with 40, Vitest's default.
