# Vendored upstream: `@vitest/istanbul-lib-instrument`

- **Repository:** https://github.com/vitest-dev/istanbuljs (`packages/istanbul-lib-instrument`; BSD-3-Clause © Yahoo! Inc. for the original `istanbul-lib-instrument`, MIT © VoidZero Inc. and Vitest contributors for the fork: both texts are in `LICENSE` here and in `THIRD_PARTY_NOTICES.md`)
- **Tag:** `v2.1.0`, commit `bce446002b0430c61735d6cdd433186ff182f2ee` (DECISIONS S3; the tag's commit was read with `git ls-remote --tags`, and the package's `package.json` says `2.1.0`)
- **Copied:** 2026-11-13, from the tag's tarball (`https://codeload.github.com/vitest-dev/istanbuljs/tar.gz/v2.1.0`) unpacked into `.refs/istanbuljs`
- **Why:** DECISIONS D110. The Istanbul instrumenter for `--coverage`: 2.5x `babel-plugin-istanbul` with the same counts (Track 8 F9), no native dependency of our own (Oxc parses). It is checked against `babel-plugin-istanbul` 8.0.0 and `istanbul-lib-instrument` 6.0.3, Jest 30.5.2's own, by `../../instrument.test.ts` and `../../initial-coverage.test.ts`.
- **Compiled as its own `tsc -b` project** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` off (DECISIONS D17), and `isolatedDeclarations` off (upstream does not annotate its exports). Biome skips this directory (`!**/vendor`), so upstream formatting stays and a diff against a newer tag stays readable.
- **Runtime dependencies,** as upstream's, except as noted: `@istanbuljs/schema` 0.1.6, `@jridgewell/remapping` 2.3.5, `@jridgewell/trace-mapping` 0.3.31, `magic-string` 1.4.5 (catalog versions, D109); `istanbul-lib-coverage` 3.2.2 in place of `@vitest/istanbul-lib-coverage`; `oxc-parser` in place of `rolldown`.

## Files

| File here | Source (`packages/istanbul-lib-instrument/src/`) | How |
|---|---|---|
| `constants.ts`, `ignored-lines.ts`, `index.ts`, `instrumenter.ts`, `istanbuljs-schema.d.ts` | same names | copied, relative imports take `.ts` |
| `parse.ts` | `parse.ts` | copied, patched (the parser) |
| `read-coverage.ts` | `read-coverage.ts` | copied, patched (the AST types) |
| `source-coverage.ts` | `source-coverage.ts` | copied, patched (`istanbul-lib-coverage`) |
| `visitor.ts` | `visitor.ts` | copied, patched (the AST types, `istanbul-lib-coverage`) |
| `LICENSE` | `LICENSE` | copied unchanged |

Not copied: `tsdown.config.ts`, `vitest.config.ts`, `tsconfig.json` (ours is `tsconfig.json` here) and `test/` (its specs and verifier are not run: `../../instrument.test.ts` compares with the real `babel-plugin-istanbul` instead).

## Local patches

Every patch is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution), in every file. Unmarked: it is mechanical.
2. **`rolldown/utils` becomes `oxc-parser`** in `parse.ts` (`parseSync`, `ESTree`), `read-coverage.ts` and `visitor.ts` (the `ESTree` types). Rolldown's `parseSync` is oxc-parser's with the same options, and `oxc-parser` re-exports `@oxc-project/types`, which is where `ESTree` comes from.
3. **`@vitest/istanbul-lib-coverage` becomes `istanbul-lib-coverage`** in `source-coverage.ts` and `visitor.ts`: Jest's own package at Jest's version (D109), so a merge or a report reads the same classes.
4. **`source-coverage.ts` types its base class.** `@types/istanbul-lib-coverage` types `classes.FileCoverage` as an instance and `toJSON` as `object`, and has no `bT`; a cast gives the class the shape the runtime has (`FileCoverageBase`), and `SourceCoverageData` gains `bT`. `@extends` in the JSDoc follows the name.
5. **`constants.ts` no longer imports `../package.json`**, and the name is the original package's, `istanbul-lib-instrument`: `_coverageSchema` is `sha1("istanbul-lib-instrument@4")`, the value `babel-plugin-istanbul` (istanbul-lib-instrument 6, Jest 30.5.2's) writes, so `coverage-final.json` and `--json`'s `coverageMap` carry Jest's schema (`provino/test/jest-coverage.test.ts` compares the whole entries). The fork's `sha1("@vitest/istanbul-lib-instrument@4")` is no longer written.
6. **The reader accepts the fork's schema value too** (`constants.ts` adds `READABLE_MAGIC_VALUES`, `read-coverage.ts` checks it): `sha1("@vitest/istanbul-lib-instrument@4")` as well as `MAGIC_VALUE`. A file the fork instrumented (a Vitest-built output) is read, not instrumented again; babel-jest's output (`canInstrument`) has `MAGIC_VALUE` itself.
