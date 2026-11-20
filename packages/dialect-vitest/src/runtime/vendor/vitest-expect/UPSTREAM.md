# Vendored upstream: Vitest's `@vitest/expect`

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © 2021-Present VoidZero Inc. and Vitest contributors)
- **`@vitest/utils`**, which these files import, is the package's one copy in `src/vendor/vitest-utils/` (its own `UPSTREAM.md`), beside the one `@vitest/pretty-format` (`src/vendor/pretty-format/`): the `.each` titles use both too, and the package's root entry may not import `/runtime`'s files.
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
| `spy.ts`, `standard-schema.ts`, `runner-types.ts`, `chai.d.ts` | none | Provino's stand-ins for `@vitest/spy` (`isMockFunction` is upstream's own, `packages/spy/src/index.ts` L17-L19), `@standard-schema/spec`'s types, the runner's `Test` type and the `Chai` namespace |

Not copied: `index.ts` (the package entry) and `jest-extend.ts`'s Chai plugin (`@provino/expect` runs `expect.extend`).

## Local patches

Every patch except the first two is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution). Not marked line by line.
2. **Package imports point at the copies**: `@vitest/utils/*` and `tinyrainbow` at `src/vendor/vitest-utils/`, `@vitest/spy`, `@standard-schema/spec` and the runner's types at the files above. Not marked line by line.
3. **`state.ts` reads the state through `@provino/expect`'s slot** (`Symbol.for('$$jest-matchers-object')`'s `state`), which owns it, one per test attempt; upstream's module body, which defines three accessors on `globalThis`, is left out.
4. **`jest-expect.ts`'s `def` doesn't put each method in the slot's `matchers` too**: the engine registers the table's matchers itself.
5. **`AsymmetricMatcher` has fields and assignments in place of parameter properties**, which Node's type stripping can't run; the own keys keep their order. The same in `jest-extend.ts`'s `JestExtendError`.
6. **`AsymmetricMatcher.prototype[Symbol.for('chai/inspect')]` is assigned through `as any`** in place of a `@ts-expect-error` for isolatedDeclarations, which this project turns off here.
7. **`jest-extend.ts` is an extract**: `JestExtendError`, the `this.utils` a custom matcher gets (`jestUtils`), and the `CustomMatcher` class as a builder (`createCustomAsymmetric`), which reads the state with no `expect` argument.
8. **`types.ts` is a stand-in**: the names the vendored files import, with `Assertion` a record over the matcher names (so `keyof Assertion` type-checks `def`) and Chai's objects loose.
9. (moved with `@vitest/utils` to `src/vendor/vitest-utils/UPSTREAM.md`.)
10. **Realm-safe equality** (T7.7, D7: a value from another `vm` context, as the `realm` tier gives each file, is judged by its class). `iterableEquality` and `typeEquality` take two built-ins of the same name from different realms as one type, as Jest 30.5.2's do (`packages/expect-utils/src/utils.ts` L195-L206, L446-L460, #14011; a user's classes still need identity); `Any` reads `Array` with `Array.isArray`, as Jest 30.5.2's does (the one site whose same-realm verdict moves: an object made with `Object.create(Array.prototype)` is no `Any(Array)` here, where upstream's `instanceof` takes it, and a `Proxy` of an array is one); and `hasAsymmetric`, `equals`' URL and `AggregateError` checks, `subsetEquality`, `arrayBufferEquality`, `getObjectSubset` and `toThrow`'s `RegExp` test use `isKind(value, Ctor, name)` (`jest-utils.ts`) where upstream uses `instanceof`: upstream's `instanceof` verdict for a value of this realm, so a subclass with its own `Symbol.toStringTag` or a plain object tagged `Date` is judged as upstream judges it, and the class tag (`isA`) only for an object of another realm (one that is no `Object` of this realm). Upstream fails 10 of `fixtures/expect/realm`'s 18 cases; this copy passes all 18 (`@provino/harness`'s `equality-corpus.test.ts`).
