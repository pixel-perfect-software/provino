# @provino/dialect-jest

The Jest 30.5 dialect. B08 built its `expect` part: the `ExpectPolicy` slice and the matcher table. The `Dialect` value (`defineDialect`), the config reader, the CLI flags, and the facades and globals come with T1.8, T11.x and T11.10 (B14, B17). Follow `.claude/rules/dialects.md` and `.claude/rules/vendored-upstream.md`.

## Layout

| Path | Entry | Role |
|---|---|---|
| `src/expect-policy.ts` | `.` | `jestExpectPolicy`. Every value is `// unverified` until T1.7 (B14). `matcherTable` is a `ModuleRef` built with `import.meta.resolve('@provino/dialect-jest/runtime')`; a bare specifier would resolve from `@provino/policy`, which can't see this package. |
| `src/runtime/expect-table.ts` | `./runtime` | `jestExpectTable()`: the 32 non-snapshot matchers with no Jest 30 aliases, `toThrow`'s promise form, the asymmetric factories and `expect.not`, `utils`, the messages and `extend`'s asymmetric form |
| `src/runtime/vendor/jest-expect/` | none | Jest v30.5.2's matcher sources. `UPSTREAM.md` lists every file, its source and every patch. |
| `src/runtime/internal/test-support.ts` | none | Spike E's interleaved runner (through core's real runtime) and the worker's boot order |

## The vendor directory

- **It's its own `tsc -b` project** (`src/runtime/vendor/tsconfig.json`), with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` off (DECISIONS D17). Its `outDir` is `.tsc/src/runtime/vendor`, so output paths mirror source paths; otherwise `rewriteRelativeImportExtensions` fails with TS2878. The package's own tsconfig excludes it and references it.
- **Biome skips it** (`!**/vendor` in `biome.json`), so Jest's formatting stays and an upstream diff (T7.15) stays readable.
- **`jestMatchersObject.ts` is Provino's file, not Jest's.** `@provino/expect` owns the slot, so this only reads it, and only when a matcher runs. Loading the vendored modules reads nothing from the slot, which `slot-order.test.ts` checks.
- **`customMatcher.ts` and `messages.ts` are extracts** from Jest's `jestMatchersObject.ts` and `index.ts`, with the line references in the files and in `UPSTREAM.md`.
- **The runtime dependencies are exact pins** at `expect@30.5.2`'s own versions (DECISIONS D18). `jest-mock` is a devDependency, for `types.ts`'s type-only import.

## Tests

- `expect-table.test.ts`: the matcher list, no aliases, the policy's `ModuleRef` loading through the behaviour loader, and the messages.
- `per-test-state.test.ts`: spike E. 50 interleaved `test.concurrent` tests through core count 50/50, with a peak of 50 running at once. A control with one shared state miscounts.
- `per-test-state-upstream.test.ts`: the same with **unmodified** `expect@30.5.2` loaded after our slot. It runs in its own process, because Jest's module writes its matchers into the slot's registry.
- `slot-order.test.ts`: loading the table never reads the slot, and a module that reads the slot as it loads sees ours.
- The Jest message goldens (T7.5): `@provino/harness`'s `expect-corpus.test.ts`. The bench: `pnpm bench:expect`.
