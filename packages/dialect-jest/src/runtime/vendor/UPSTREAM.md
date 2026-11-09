# Vendored upstream: Jest's `expect` matchers

- **Repository:** https://github.com/jestjs/jest (MIT, © Meta Platforms, Inc. and affiliates)
- **Tag:** `v30.5.2`, commit `202dd8a14777c270607c2416bd5034c3c0abc984` (DECISIONS S3; the tag was resolved with `gh api` on 2026-11-03)
- **Copied:** 2026-11-03, from the tag's tarball in `.refs/jest`
- **Compiled as its own `tsc -b` project** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` off (DECISIONS D17). Biome skips this directory, so upstream formatting stays and a diff against a newer tag stays readable (T7.15).
- **Runtime dependencies,** pinned to what `expect@30.5.2` depends on (DECISIONS D18): `@jest/expect-utils` 30.5.2, `@jest/get-type` 30.5.0, `jest-matcher-utils` 30.5.2, `jest-message-util` 30.5.1 and `jest-util` 30.5.1, and, for the snapshot printer (B17b), `pretty-format` 30.5.1, the version `jest-matcher-utils@30.5.2` and `jest-snapshot@30.5.2` themselves depend on (so the install gains no package). `types.ts` imports `jest-mock` for types only, so `jest-mock` 30.5.2 is a devDependency.

## Files

| File here | Source (`packages/expect/src/`) | How |
|---|---|---|
| `jest-expect/matchers.ts` | `matchers.ts` | copied, patched |
| `jest-expect/spyMatchers.ts` | `spyMatchers.ts` | copied, patched |
| `jest-expect/toThrowMatchers.ts` | `toThrowMatchers.ts` | copied, patched |
| `jest-expect/asymmetricMatchers.ts` | `asymmetricMatchers.ts` | copied, patched |
| `jest-expect/print.ts` | `print.ts` | copied unchanged |
| `jest-expect/types.ts` | `types.ts` | copied, patched (the other files import it) |
| `jest-expect/customMatcher.ts` | `jestMatchersObject.ts` L79–L107 | extracted: `expect.extend`'s asymmetric `CustomMatcher`, its class body unchanged, in a factory called once per registration, so every instance shares one class as in Jest |
| `jest-expect/messages.ts` | `index.ts` L107, L161, L182–L192, L205–L213, L256–L264, L430–L435, L451; `jestMatchersObject.ts` L66, L135; `extractExpectedAssertionsErrors.ts` L46–L56, L65–L73 | extracted: the engine's own failure text, each expression Jest's, as functions (the two assertion-count texts are `assertionCount` and `noAssertions`) |
| `jest-expect/jestMatchersObject.ts` | none | **Provino's own file**, standing in for Jest's: `@provino/expect` owns the slot, so this only reads it |
| `jest-snapshot/mockSerializer.ts` | `packages/jest-snapshot/src/mockSerializer.ts` (v30.5.2) | copied unchanged (B17b, T7.10): how a mock function prints in a snapshot. The plugin order, `serialize` and the words are `../../snapshot-printer.ts`, composed from `jest-snapshot`'s `plugins.ts` L9-L22, `utils.ts` L56-L72 and `index.ts`/`printSnapshot.ts` |

Not copied: `index.ts` (the front end, which `@provino/expect` replaces), `jestMatchersObject.ts` (the slot, owned by `@provino/expect`) and `extractExpectedAssertionsErrors.ts` (its two message texts are extracted into `messages.ts`; the counting is `@provino/expect`'s `end-of-test.ts`, T7.8).

## Local patches

Every patch is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution), in all five patched files.
2. **Parameter properties become fields** in `AsymmetricMatcher`'s constructor (`erasableSyntaxOnly`).
3. **`isolatedDeclarations` annotations:** `$$typeof: symbol`, and the return types of the `asymmetricMatch` and `getExpectedType` methods in `asymmetricMatchers.ts`.
4. **The DOM type names** (`NodeListOf<Node>`, `DOMTokenList`, `HTMLCollectionOf<any>`) in `matchers.ts`'s `ContainIterable` become `Iterable<unknown>`. The DOM lib isn't loaded, and the type only describes what `toContain` iterates.
