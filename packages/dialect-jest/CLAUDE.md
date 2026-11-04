# @provino/dialect-jest

The Jest 30.5 dialect. B08 built its `expect` part: the `ExpectPolicy` slice and the matcher table. B10 added the `Dialect` value (`jestDialect`, with `jestPolicy`) and the globals (`jestGlobals`). Still to come: the values' ground truth (T1.7/T1.8, B14), the config reader and CLI flags (T11.x), and the full `jest` object and the `@jest/globals` facade (T11.10, B13, B17). Follow `.claude/rules/dialects.md` and `.claude/rules/vendored-upstream.md`.

## Layout

| Path | Entry | Role |
|---|---|---|
| `src/dialect.ts` | `.` | `jestPolicy` (a `PolicyOverrides`: every key the research gives a Jest 30.5 value for) and `jestDialect` (`defineDialect`: `name`, `version: '30.5'`, `policy: jestPolicy`, `globals`). `Dialect.policy` is typed as overrides-or-factory, so `jestPolicy` is exported too for code that needs the overrides (`resolvePolicy(jestPolicy)`; the harness's runtime corpus does). `globals.factory` is a `ModuleRef` to `jestGlobals` built with `import.meta.resolve('@provino/dialect-jest/runtime')`. The header comment lists the keys left at the neutral value and why; `dialect.test.ts` pins that list. |
| `src/expect-policy.ts` | `.` | `jestExpectPolicy`. Every value is `// unverified` until T1.7 (B14). `matcherTable` is a `ModuleRef` built with `import.meta.resolve('@provino/dialect-jest/runtime')`; a bare specifier would resolve from `@provino/policy`, which can't see this package. |
| `src/runtime/expect-table.ts` | `./runtime` | `jestExpectTable()`: the 32 non-snapshot matchers with no Jest 30 aliases, `toThrow`'s promise form, the asymmetric factories and `expect.not`, `utils`, the messages and `extend`'s asymmetric form |
| `src/runtime/vendor/jest-expect/` | none | Jest v30.5.2's matcher sources. `UPSTREAM.md` lists every file, its source and every patch. |
| `src/runtime/globals.ts` | `./runtime` | `jestGlobals(host)`: Jest 30.5's 14 injected globals. `describe`/`it`/`test`/hooks are core's `RuntimeApi`, `fdescribe`/`fit`/`xdescribe`/`xit`/`xtest` its `only`/`skip` modifiers, `expect` the host's. `jest` has `isolateModules`, `isolateModulesAsync` and `resetModules` over `host.registry()` (read at call time: each file has its own registry), and nothing else (mocks, timers, `retryTimes`: T11.10, B13). `JestGlobalsHost` narrows `GlobalsHost` to core's and expect's real types. |
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
- `dialect.test.ts`: the dialect's divergences from the neutral policy (a few known rows, not a snapshot), `serializePolicy` on the resolved policy (every behaviour key is a ref), and the list of keys left at the neutral value.
- `runtime/globals.test.ts`: `jestGlobals` over a real core runtime and the Jest `expect` (focus and skip through `fit`/`xit`/`fdescribe`/`xdescribe`, hooks, a failing `expect`), the `jest` object over a recording registry, the keys against `jestDialect.globals.names`, and the factory ref loading through the behaviour loader. It lives under `runtime/` because the root node may not import `./runtime`.
- The `core` values moved here from the harness's runtime-corpus profiles, so `@provino/harness`'s `runtime-corpus.test.ts` checks the dialect's own: every "runtime corpus X agrees" comment in `dialect.ts` is a claim that check makes true (flip the value and it fails).
- The Jest message goldens (T7.5): `@provino/harness`'s `expect-corpus.test.ts`. The bench: `pnpm bench:expect`.
