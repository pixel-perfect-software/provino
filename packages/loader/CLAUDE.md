# @provino/loader

The module loader (Track 2): a two-phase module-runner engine. One `Loader` per worker; one `FileRegistry` per test file. The contract (`Loader`, `FileRegistry`, `LoaderOptions`, `CreateLoader`) lives in `@provino/types`. The spec is Track 2 R1–R2 and F3; B06's notes are in `docs/plan/bundles/B06.md`.

## Two halves

- **Worker-wide: `src/internal/records.ts`.** Each user module has one `ModuleRecord` per worker:
  - transformed once: the `ModuleTransformer` (the pipeline), then `toModuleRunner` from `@provino/transform` for files with ESM syntax;
  - its static deps resolved once;
  - compiled once with `vm.runInThisContext`, with `filename` set to the real path.

  `linkAsync`/`linkSync` walk the static graph. Externals (anything under `node_modules` that `inline` doesn't match, plus addons and builtins) are loaded natively and shared: `import()` when async, `require`/`require(esm)` when sync. `asyncGraph` marks top-level-await subgraphs, as a fixed point over cycles.
- **Per file: `src/internal/registry.ts`.** A stack of instance maps; the top one is live, and `isolateModules` pushes a fresh one. Evaluation calls a record's compiled wrapper with fresh linkers, so module state is per registry while compiled code is shared.
  - `resetModules` empties every layer in place and keeps the stack's depth, so a reset inside `isolateModules` leaves the registry (under `none`, the worker's shared one) usable.
  - `isolate`/`isolateAsync` remove the map they pushed, by identity, not whatever is on top: overlapping async isolates each drop only their own map. They still share the one stack, so whichever pushed last is live for both; there is no per-call context. The loader has no nesting ban; Jest's "cannot be nested" error belongs to the Jest dialect.

`src/loader.ts` holds `createLoader` and the tiers. `registry` creates a new `Registry` per file; `none` reuses one per loader.

`src/project.ts` holds `createProjectLoader(root, config, policy.module)`: the worker's way in. It builds the resolver and the transform pipeline from a clone-safe `SerializedLoaderConfig` (the worker entry may not import either), loads the config's mappers by `ModuleRef` (so it is async), and calls `createLoader` with the runner engine. Hoisting and the transform cache are off until their tasks (B13, T3.6).

- **`tsconfig`:** `'auto'` and `false` pass through. Any other string is a file path, resolved against `root` (never the process cwd) for both the resolver and the pipeline, and it must be a file: otherwise `createProjectLoader` rejects with `LOADER_TSCONFIG_NOT_FOUND`, naming the resolved path.
- **Mappers:** each factory's result must be an object with a string `id` and a `map` function. A factory that throws (the error is the `cause`) or returns anything else rejects with `LOADER_INVALID_MAPPER`, naming `loader.mappers[<i>]`. Factories are called synchronously, as `ModuleMapperFactory` says.

`FileRegistry.invalidate(specifier, parent?)` drops the live instance of the user module the specifier resolves to, in the top map of an `isolateModules` stack. It resolves the specifier as an `import` and as a `require` and drops both ids, since a package's `exports` can map the two to different files and either may be the loaded one (a kind that doesn't resolve is skipped). The module evaluates again on its next import; its dependencies and modules that already imported it keep their instances. An external, a builtin, a module never loaded and a specifier that doesn't resolve are no-ops. Under `none` the registry is shared, so it reaches every file of the worker.

## The wrapper shape (oxc's runner output, Vite's shape)

- **Imports** become `const __vite_ssr_import_N__ = await __vite_ssr_import__('./x', { importedNames })`. Uses become `__vite_ssr_import_N__.x`, which stays live.
- **Exports** become getters on `__vite_ssr_exports__`, hoisted above the imports, so cycles see live bindings.
- **`export *`** becomes `__vite_ssr_exportAll__(ns)`: one argument, bound to the module's own exports.
- **Other rewrites:** `import()` becomes `__vite_ssr_dynamic_import__`, and `import.meta` becomes `__vite_ssr_import_meta__`.
- **Sync evaluation:** a module whose graph has no top-level await gets the plain `function` wrapper, with `await __vite_ssr_import__(` stripped. Only `asyncGraph` modules use the `async function` wrapper.
- **CJS** user files use Node's `(exports, require, module, __filename, __dirname)` wrapper. `require()` of an `asyncGraph` ESM module throws `ERR_REQUIRE_ASYNC_MODULE`.

## Not here yet (each throws `LOADER_NOT_IMPLEMENTED`, or is a stub)

| Piece | Task |
|---|---|
| `registerMock`/`unregisterMock`; `importActual`/`requireActual` are the plain calls until then | T2.5 (B13c) |
| Mock-aware auto-inlining | T2.6 (B13c) |
| Leak snapshot/restore (`dispose()` returns an empty `LeakReport`) | T2.7 |
| The `realm` tier | T2.8 |
| Source-mapped stacks and coverage: `onModuleCompiled` reports `wrapperColumnOffset` for each script | T2.9 |
| `tierFor` escalation by `@provino-isolate` (it returns the configured tier) | T2.11 |
| `engine: 'native'` | T2.10 |
| A semantics suite against native Node | T2.3 |

## Gotchas

- **Sync `require()` of ESM user code that imports a CJS external** builds that external's namespace from its own keys, since native `import()` is async. The async path is exact.
- **The deprecated oxc runner transform aborts the process on unstripped TypeScript.** Only `toModuleRunner`, in `@provino/transform`, may call it, and only on the pipeline's output (DECISIONS D10).
- **Checks:**
  - `pnpm bench:loader check`: the Spike A fixture, 600/600 and 0 violations.
  - `pnpm bench:loader isolation`: registry overhead.
  - `pnpm bench:loader e2e`: vs Jest.
  - `packages/bench/src/loader/fixture.test.ts` runs the 600/600 check in `pnpm test`.
