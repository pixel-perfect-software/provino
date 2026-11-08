# Vendored upstream: natural-compare and Jest's snapshot merge

| File here | Source | How |
|---|---|---|
| `natural-compare.ts` | natural-compare 1.4.0 (https://github.com/litejs/natural-compare-lite, MIT, © Lauri Rooden), `index.js` | ported to TypeScript; the key order of a `.snap` file in both runners |
| `deep-merge.ts` | Jest v30.5.2 (https://github.com/jestjs/jest, MIT, © Meta Platforms, Inc. and affiliates), `packages/jest-snapshot/src/utils.ts` L25-L135 | ported to `unknown` and a record type; how property matchers merge into the received value |

- **Jest** is the tag `v30.5.2`, commit `202dd8a14777c270607c2416bd5034c3c0abc984` (DECISIONS S3), copied on 2026-11-08 from `.refs/jest`.
- **natural-compare** has no tag in `.refs`; the file was read from the install the Jest 30.5.2 lockfile pins (1.4.0). It is a dependency of neither package here: the vendored copy is the code, and `natural-compare` is a devDependency of `@provino/snapshot` only, as the oracle its test compares the port with.
- **Compiled with the package** (strict, unlike `dialect-jest`'s vendor directory): both files are small enough to meet the package's flags.

## Local patches

Every patch is marked `// provino: <reason>` in the file.

1. **`natural-compare.ts`:** `String.alphabet`, an optional global hook the original reads, is not supported (nothing sets it, and a hidden global would make the order of a file depend on the process); the shared `i` of its inner function is a `let` the numeric branch assigns; the digit loop is a `while`.
2. **`deep-merge.ts`:** typed with `unknown` and a record type in place of `any`; the logic is Jest's.
