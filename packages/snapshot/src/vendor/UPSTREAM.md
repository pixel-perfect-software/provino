# Vendored upstream: natural-compare, Jest's snapshot merge and the snapshot printer

| File here | Source | How |
|---|---|---|
| `natural-compare.ts` | natural-compare 1.4.0 (https://github.com/litejs/natural-compare-lite, MIT, © Lauri Rooden), `index.js` | ported to TypeScript; the key order of a `.snap` file in both runners |
| `deep-merge.ts` | Jest v30.5.2 (https://github.com/jestjs/jest, MIT, © Meta Platforms, Inc. and affiliates), `packages/jest-snapshot/src/utils.ts` L25-L135 | ported to `unknown` and a record type; how property matchers merge into the received value |
| `pretty-format/` | pretty-format 30.5.1 (Jest `v30.5.2` checkout, `packages/pretty-format/src/`: `index.ts`, `collections.ts`, `types.ts`, `plugins/*`) | copied, patched; how a snapshot value prints (D210) |
| `jest-snapshot/mock-serializer.ts` | Jest v30.5.2, `packages/jest-snapshot/src/mockSerializer.ts` | copied, one import patched; how a mock function prints |
| `jest-snapshot/escape-backtick.ts` | Jest v30.5.2, `packages/jest-snapshot-utils/src/utils.ts` L167-L168 (`@jest/snapshot-utils` 30.5.1) | copied, unpatched; how the native inline writer (`../inline/index.ts`) escapes a snapshot for a template literal |
| `react-is/v18.ts`, `react-is/v19.ts` | react-is 18.3.1 (`cjs/react-is.production.min.js`) and 19.3.1 (`cjs/react-is.production.js`), MIT, © Meta Platforms, Inc. and affiliates | ported to TypeScript, only the predicates the React plugin calls; they stand in for `@jest/react-is-18` and `@jest/react-is-19` |
| `ansi-styles/index.ts` | ansi-styles 5.2.0 (https://github.com/chalk/ansi-styles, MIT, © Sindre Sorhus), `index.js` | ported to TypeScript; the colours of `highlight: true` |

`pretty-format` is the version `jest-snapshot@30.5.2` depends on. It is a devDependency of `@provino/snapshot` only, the oracle of `printer/printer.test.ts`, which runs the installed package and the vendored copy over one table of values.

- **Jest** is the tag `v30.5.2`, commit `202dd8a14777c270607c2416bd5034c3c0abc984` (DECISIONS S3), copied on 2026-11-08 from `.refs/jest`.
- **natural-compare** has no tag in `.refs`; the file was read from the install the Jest 30.5.2 lockfile pins (1.4.0). It is a dependency of neither package here: the vendored copy is the code, and `natural-compare` is a devDependency of `@provino/snapshot` only, as the oracle its test compares the port with.
- **Compiled with the package** (strict, unlike `dialect-jest`'s vendor directory): both files are small enough to meet the package's flags.

## Local patches

Every patch is marked `// provino: <reason>` in the file.

1. **`natural-compare.ts`:** `String.alphabet`, an optional global hook the original reads, is not supported (nothing sets it, and a hidden global would make the order of a file depend on the process); the shared `i` of its inner function is a `let` the numeric branch assigns; the digit loop is a `while`.
2. **`deep-merge.ts`:** typed with `unknown` and a record type in place of `any`; the logic is Jest's.

## Local patches: the printer
 
5. **Imports:** `.ts` on every relative import; `ansi-styles` and `@jest/react-is-18`/`-19` point at the copies here; `mock-serializer.ts` takes `NewPlugin` from `../pretty-format/index.ts`.
6. **`pretty-format/types.ts`:** `SnapshotFormat` (a TypeBox type in `@jest/schemas`) is written out as the type it infers.
7. **`ansi-styles/index.ts`:** typed with `any` where the original is untyped; it exports one assembled object, where upstream's export is a getter that assembles a new one per access.
8. **Compiled apart:** `tsconfig.json` here relaxes `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `isolatedDeclarations` and loads the DOM lib (the DOM plugins name its types), as `dialect-jest`'s vendor projects do (D17). Biome skips this directory.
