# @provino/dialect-vitest

The Vitest 5.0 dialect (B14a: T1.8's Vitest half, T11.1, T11.2). Policy values, the names of the globals Vitest injects with `globals: true`, the hoisting rules and the type entries. The config reader, the CLI flags and the `vitest` facade are T11.15 and T11.16 (Phase 2); until then `provino` doesn't list this dialect among its built-ins, so no run reaches the stubs. Follow `.claude/rules/dialects.md`.

## Layout

| Path | Entry | Role |
|---|---|---|
| `src/dialect.ts` | `.` | `vitestPolicy` (a `PolicyOverrides` with Vitest's `sequence.hooks: 'stack'` default), `vitestDialect` (`name`, `version: '5.0'`, `policy`, `globals` with the 19 names of Vitest's `globalApis` and a factory ref to `/runtime`'s `vitestGlobals`, `loader.hoist`, `typeEntries: ['@provino/dialect-vitest/runtime']`), and the `DialectRegistry` augmentation (`vitest: VitestDialectOptions`, `Record<string, never>` until the config reader). |
| `src/mock-policy.ts` | `.` | `vitestMockPolicy` and `vitestModulePolicy`, moved here from the harness's mock corpus (B13a, B13b recorded them). |
| `src/hoist-policy.ts` | `.` | `vitestHoistPolicy`: `@vitest/mocker` 5.0.5's hoisting rules, moved from the harness (B13b). |
| `src/runtime/index.ts` | `./runtime` | `formatEachTitle` (T5.4, below); `vitestEnvironmentConditions` (`orchestrator.environmentConditions`, T8.7: `node` whatever the environment, `jsdom` included, recorded in `env/conditions-vitest-jsdom` from Vitest 5.0.5; the neutral default would say `browser`); `vitestGlobals`, a stub that throws `VitestDialectError` `VITEST_DIALECT_NOT_BUILT`; and `vitestSnapshotPrinter` (B17b, T7.10; `snapshot.printer`). |
| `src/each/format-each-title.ts` | `./runtime` | `formatEachTitle` (`core.formatEachTitle`): Vitest 5.0.5's `formatTitle` (`%s %d %i %f %j %o %O %c %%`, `%#`/`%$` every occurrence, `$a`, `$a.b`, `$0`, `%p` literal) over the row as an array (an object or primitive row is `[row]`). It cuts each value to 40 characters itself (`taskTitleValueFormatTruncate`): a behaviour takes no policy. With the table's `kind` `mixed` a single array item is spread again, as Vitest's `toArray` does. |
| `src/each/title-truncate.ts` | `.` | `VITEST_EACH_TITLE_TRUNCATE` (40): `vitestPolicy.core.eachTitleTruncate` and the formatter both read it, so the root entry (which the coordinator loads) doesn't pull in the vendored formatter. |
| `src/each/vendor/` | none | `formatTitle` (extract of the runner's `suite.ts`), `@vitest/utils`' `display.ts` (`format`, `inspect`) and `@vitest/pretty-format`, all v5.0.5. Its own `tsc -b` project (DOM libs on: the plugins name DOM types); `UPSTREAM.md` lists the patches. No `ReactElement` plugin (it needs `react-is`) and no tinyrainbow. |
| `src/runtime/snapshot-printer.ts` | `./runtime` | The vendored `@vitest/pretty-format` with Vitest's `serialize` defaults and plugin order (the mock serializer last), and Vitest's words: a mismatch only names the key (its reporter draws the diff). |
| `src/vendor/pretty-format/` | none | `@vitest/pretty-format` 5.0.5 and the snapshot mock serializer, vendored (its own `tsc -b` project, D17; see its `UPSTREAM.md` for the four patches: `.ts` imports, `tinyrainbow` inlined, the `ReactElement` plugin left out, the DOM names as loose types). B17a's `format`/`inspect` and their own `pretty-format` copy are in `src/each/vendor/` (the second copy is a follow-up to fold into this one). |
| `src/node/index.ts` | `./node` | `vitestNodeDialect`: the dialect value itself, until the config reader and flags exist. |

## Where the values come from

Every value matches Vitest 5.0.5, and its evidence is in `@provino/harness`'s `src/policy-truth/claims/` (T1.7): a golden recorded from the real Vitest, a corpus check a flipped value fails, our own key with its test (`isolationDefault`, the hoisting `id`, `valueFormatter`: `dialect.test.ts` pins them), a value nothing reads, or `pending` with its owner. `policy-truth.test.ts` there fails when a value and its evidence disagree. A recording overruled the research once: `core.errors.hasAssertionsWhenFailed` is `skip` (Vitest checks `expect.hasAssertions` only on a test that passed, `policy/core-outcomes`).

`core.retry.functionCondition` is `ignore-warn` (D7): Vitest 5.0.5 never calls a function `retry.condition` and retries every failure (`runtime/retry-condition-function`), and honouring it could turn a green suite red, so this dialect keeps that outcome and core warns once a file with a fix hint; the neutral and Jest value, `call`, asks the function.

`vitest-list` (`sequence.hooks: 'list'`) is a project config, not a dialect: the harness's corpus profiles layer it over `vitestPolicy`.

## Tests

- `dialect.test.ts`: the value, a few divergences from neutral, every ref absolute (D21), the globals' factory loading and throwing its code, the own keys.
- `defaults.test.ts` (T11.2): the values `vitest/config` 5.0.5 has a default for, against `configDefaults` and `coverageConfigDefaults` read in-process; the environment-dependent defaults (`allowOnly`, `watch`, `open`, `reporters`) are not compared. And Track 11's module-boundaries table row by row.
- `each/format-each-title.test.ts` (T5.4): the vendored `inspect` and `format` against the real `@vitest/utils` (reached from `vitest`, so no new dependency) over 38 values, `formatEachTitle` against 35 titles taken from the recorded goldens (`fixtures/runtime/each-*`: Vitest 5.0 doesn't export `formatTitle`, so the corpus is the oracle), the 40-character cut, and the two crashes (`%j` on a bigint, `%d` on a null-prototype object) that fail a Vitest file at collection. Core passes `[]` for a `null` or `undefined` row of `.for` (`each-for-nullish`).
- `node/node.test.ts`: the coordinator entry. `test/dialect-vitest.test-d.ts`: the public types and misuse cases.
