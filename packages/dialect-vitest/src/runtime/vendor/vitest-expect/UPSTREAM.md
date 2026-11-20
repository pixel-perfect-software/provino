# Vendored upstream: Vitest's `@vitest/expect` and `@vitest/utils`

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © 2021-Present VoidZero Inc. and Vitest contributors; the `diff/` files keep the Meta Platforms header they were forked from Jest with)
- **Tag:** `v5.0.5`, commit `7a825db43e2beca0b219d2eadaec334cb81af0c7` (DECISIONS S3)
- **Copied:** 2026-11-19, from the clone in `.refs/vitest` (B25b, T7.6, D170)
- **Compiled as its own `tsc -b` project** (`tsconfig.json` here) with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedDeclarations`, `noImplicitOverride` and `noImplicitReturns` off and `esnext.error` in `lib` (`Error.isError`) (DECISIONS D17). Biome skips the directory (`!**/vendor`), so upstream formatting stays and `pnpm drift` stays readable.
- **One runtime dependency, Chai** (D172), never imported here: the stand-in `chai` the plugins run over (`src/runtime/expect/assertion.ts`) loads it on a failure or a Chai assertion.

## Files

| File here | Source | How |
|---|---|---|
| `expect/jest-expect.ts` | `packages/expect/src/jest-expect.ts` | copied, patched (1, 2, 4, 10) |
| `expect/jest-asymmetric-matchers.ts` | `packages/expect/src/jest-asymmetric-matchers.ts` | copied, patched (1, 2, 5, 6, 10) |
| `expect/custom-matchers.ts`, `chai-style-assertions.ts`, `jest-matcher-utils.ts`, `constants.ts`, `utils.ts` | `packages/expect/src/` | copied (1, 2) |
| `expect/jest-utils.ts` | `packages/expect/src/jest-utils.ts` | copied, patched (1, 2, 10) |
| `expect/state.ts` | `packages/expect/src/state.ts` | rewritten (3) |
| `expect/jest-extend.ts` | `packages/expect/src/jest-extend.ts` L61-L73, L23-L29, L131-L160 | extracted (7) |
| `expect/types.ts` | none | Provino's stand-in for `packages/expect/src/types.ts` (8) |
| `utils/display.ts` | `packages/utils/src/display.ts` | copied, patched (1, 2, 9) |
| `utils/helpers.ts`, `constants.ts`, `types.ts`, `error.ts`, `serialize.ts`, `nanoid.ts`, `random.ts` | `packages/utils/src/` | copied (1, 2) |
| `utils/diff/*.ts` | `packages/utils/src/diff/` | copied (1, 2; `index.ts` also 9) |
| `diff-sequences.ts` | Jest v30.5.2, `packages/diff-sequences/src/index.ts` (`.refs/jest`) | copied unchanged: `@vitest/utils` bundles diff-sequences |
| `tinyrainbow.ts` | tinyrainbow 3.2.0, `dist/index.js` (the npm tarball `@vitest/utils` 5.0.5 installs; tinyrainbow has no `.refs` clone) | ported to TypeScript: the same colour test and escape pairs, the names spelled out |
| `spy.ts`, `standard-schema.ts`, `runner-types.ts`, `chai.d.ts` | none | Provino's stand-ins for `@vitest/spy` (`isMockFunction` is upstream's own, `packages/spy/src/index.ts` L17-L19), `@standard-schema/spec`'s types, the runner's `Test` type and the `Chai` namespace |

Not copied: `index.ts` (the package entry), `jest-extend.ts`'s Chai plugin (`@provino/expect` runs `expect.extend`), and `@vitest/utils`' other entries.

## Local patches

Every patch except the first two is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution). Not marked line by line.
2. **Package imports point at the copies here**: `@vitest/utils/*` at `utils/`, `@vitest/pretty-format` at the package's one copy (`src/vendor/pretty-format/`), `tinyrainbow`, `diff-sequences`, `@vitest/spy`, `@standard-schema/spec` and the runner's types at the files above. Not marked line by line.
3. **`state.ts` reads the state through `@provino/expect`'s slot** (`Symbol.for('$$jest-matchers-object')`'s `state`), which owns it, one per test attempt; upstream's module body, which defines three accessors on `globalThis`, is left out.
4. **`jest-expect.ts`'s `def` doesn't put each method in the slot's `matchers` too**: the engine registers the table's matchers itself.
5. **`AsymmetricMatcher` has fields and assignments in place of parameter properties**, which Node's type stripping can't run; the own keys keep their order. The same in `jest-extend.ts`'s `JestExtendError`.
6. **`AsymmetricMatcher.prototype[Symbol.for('chai/inspect')]` is assigned through `as any`** in place of a `@ts-expect-error` for isolatedDeclarations, which this project turns off here.
7. **`jest-extend.ts` is an extract**: `JestExtendError`, the `this.utils` a custom matcher gets (`jestUtils`), and the `CustomMatcher` class as a builder (`createCustomAsymmetric`), which reads the state with no `expect` argument.
8. **`types.ts` is a stand-in**: the names the vendored files import, with `Assertion` a record over the matcher names (so `keyof Assertion` type-checks `def`) and Chai's objects loose.
9. **No `ReactElement` plugin** in `display.ts`'s and `diff/index.ts`'s plugin lists (it needs `react-is`); the one `@vitest/pretty-format` copy doesn't have it either.
10. **Realm-safe equality** (T7.7, D7: a value from another `vm` context, as the `realm` tier gives each file, is judged by its class). `iterableEquality` and `typeEquality` take two built-ins of the same name from different realms as one type, as Jest 30.5.2's do (`packages/expect-utils/src/utils.ts` L195-L206, L446-L460, #14011; a user's classes still need identity); `Any` reads `Array` with `Array.isArray`, as Jest's does; and `hasAsymmetric`, `equals`' URL and `AggregateError` checks, `subsetEquality`, `arrayBufferEquality`, `getObjectSubset` and `toThrow`'s `RegExp` test read the class (`isA`, `Object.prototype.toString`) where upstream uses `instanceof`. Upstream fails 10 of `fixtures/expect/realm`'s 18 cases; this copy passes all 18 (`@provino/harness`'s `equality-corpus.test.ts`).
