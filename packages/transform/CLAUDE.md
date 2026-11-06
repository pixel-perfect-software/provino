# @provino/transform

The per-file transform pipeline (Track 3): TypeScript and JSX through Oxc, mock hoisting, source-map composition, import records, and the stopgap module-runner rewrite. Follow `.claude/rules/typescript.md`.

## Layout

| Path | Role |
|---|---|
| `src/pipeline.ts` | `createPipeline().transform(request)`: route by extension, `oxc-transform.transformSync` with tsconfig-derived options, then `hoistMocks` for every role but `dependency` (B13b Gap 3), then the record's import facts. `hasTopLevelAwait` is `true` when the hoist step rewrote imports (`moduleFacts` reads the original source and never sees that `await`). Hoister diagnostics are appended to the record's. The pipeline passes `source` as `original` (see "Generated names"). |
| `src/module-runner.ts` | `toModuleRunner`: the only caller of oxc's deprecated `moduleRunnerTransformSync` (D10). Only ever sees stripped output. |
| `src/internal/` | `maps.ts` (compose maps), `imports.ts` (import records), `tsconfig.ts` |
| `src/hoist/` | The mock hoister (T3.4), below. |

## The hoister (`src/hoist/`)

`hoistMocks(code, policy, { filename, original? }) -> { code, map, staticMocks, diagnostics, rewroteImports }`. One neutral engine driven entirely by a `HoistPolicy`; it never compares against a runner's name. Pure: it reads nothing but its arguments.

| File | Role |
|---|---|
| `index.ts` | `hoistMocks`: prefilter, parse, analyse, apply. Any error returns the input untouched, with the errors as diagnostics. |
| `prefilter.ts` | `\b(?:names)\s*\(` built from the policy's `hoistCalls`, `hoistValues` and `rewriteImportArg`, cached per policy. No hit returns the input with `map: null`. A hit in a comment or string costs one parse and edits nothing. |
| `parse.ts` | `oxc-parser` `parseSync`, with `experimentalRawTransfer` when `rawTransferSupported()` (about 3x faster), `lang: 'jsx'`, `sourceType: 'unambiguous'` (CommonJS files work), `preserveParens: false`. A syntax error is `PARSE_ERROR`. |
| `analyse.ts` | Finds what to hoist and checks the policy's rules; edits nothing. Two walks share one `oxc-walker` `ScopeTracker`: the first only declares, so a `jest` imported below the call still resolves; the second, frozen, resolves each name from inside the walk. Recognition goes through `policy.objects`. |
| `purity.ts` | Babel's `scope.isPure(node, true)`, for `hoistPureConsts`. |
| `apply.ts` | The edits, with `magic-string`: `move` for hoisted statements (so positions survive in the map), `overwrite`/`update` for rewritten references. |
| `diagnostics.ts` | Positions (1-based line and column, as the pipeline reports them), code frames, and `{call}`/`{name}` filling from `policy.messages`. |
| `test-policies.ts`, `test-helpers.ts` | Small inline policies and helpers for the tests. They are not the dialects' values. |

Tests: `rules-block.test.ts` (enclosing-block rules, one rule per case), `rules-top-level.test.ts` (top-level-only rules), `rules-generated.test.ts`, `imports.test.ts` (the import rewrite), `maps.test.ts` (28 probes traced with `@jridgewell/trace-mapping` to exact line and column). The agreement with the real Jest and Vitest hoisters is `packages/harness/src/hoist-corpus.test.ts`; the cost bar is `pnpm bench:hoist`.

### Two placements

- **`enclosing-block`** (the shape of Jest's plugin): a chain of calls on a mock object that is an expression statement, and whose calls all satisfy their argument rule, moves to the top of its own block. Hoisted pure `const`s (`hoistPureConsts`) go first, then calls, each in source order. A call whose arguments fail its rule, or a chain with one non-hoisting call, stays put and is not an error.
- **`top-level-only`** (the shape of Vitest's): a call anywhere is a candidate; its statement must be directly in the program (or in an `if (<topLevelGuards>) {}` block, which hoists wrapped in the guard). Otherwise `HOIST_NOT_TOP_LEVEL`; a hoisted call inside another is `HOIST_NESTED`; exporting a result is `HOIST_EXPORTED`.

### The import rewrite (B13b P9)

The module-runner transform moves every import above everything, so a mock call below an import would never apply. Under both policies, when a call moves to the top of a file that has static imports, the output is: runner-module imports (`policy.runnerModules`, kept static), the hoisted block, `const __provino_import_N__ = await import('./a')` in source order, then the rest, with every use rewritten through scope analysis (`.x`, `.default`, the namespace itself, `{ x }` becomes `{ x: ….x }`; shadowed names stay). `export { x }` of an import, and `export { a } from`, get a `__provino_ref_K__` local to export; `export * as ns` exports the namespace.

- **`policy.reExports` says what happens to `export … from`.** `'in-order'` (Jest: Babel's CJS step keeps source order) loads each with the imports, after the hoisted block. `'static'` (Vitest: `hoistMocks.ts` rewrites only `ImportDeclaration`) leaves every one as written, including `export *` and named re-exports, so the module-runner transform moves them above the mocks and a re-exported module loads before mocks exist. `re-exports.test.ts` covers both, and that each output survives `toModuleRunner`.
- **Under `in-order`, `export * from` has no dynamic form in ESM.** It becomes `await import()` plus `__vite_ssr_exportAll__(ns)`, the module-runner helper the loader's wrapper passes in. So the hoister's output is only valid as input to `toModuleRunner` when a file has `export *` and a program-level hoist.
- A block-level hoist leaves imports alone; a file with no static imports has nothing to rewrite (`rewroteImports: false`).
- The moves use an anchor that stays: a magic-string index names the original position of a chunk, so `arrange` in `apply.ts` anchors at the first statement that does not move, and at the last statement (moves on both sides) when every statement in a body moves.

### Generated names

Hoisting runs after the JSX and TypeScript step, so a factory can read names the transform made (`_jsxDEV`). `options.original` is the source before the transform: a free identifier in a factory that does not occur in it, as a whole identifier, was generated and is allowed, under any policy. Without `original` nothing extra is allowed.

### Contract choices

- Calls keep their text. Nothing is rewritten to `__provino_mock__.register` (B13b Gap 1).
- `staticMocks` lists hoisted calls with a literal, template, or `import()` specifier, in source order. `automock` is "exactly one argument". `factoryLoadsOriginal` is a factory with parameters, or whose text names `importActual`/`importOriginal`/`requireActual`/`requireOriginal`. `loc` and diagnostic positions are in the hoister's input (the stripped code), not the original TypeScript.
- A hoisted `const` in a multi-declarator declaration is allowed by the factory rule but not moved.
- Code frames are two lines of context either side of the position, with a caret; the text is the policy's.

## Not done here

`FileRegistry.registerMock`, `decide()` per edge, and turning `hoist` on in the real loader are B13c. Caching hoist output is T3.6. The native hoist pass is Phase 3.
