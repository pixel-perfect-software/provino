# @provino/loader

The module loader (Track 2): a two-phase module-runner engine. One `Loader` per worker; one `FileRegistry` per test file. The contract (`Loader`, `FileRegistry`, `LoaderOptions`, `CreateLoader`, `ModuleMockRegistry`) lives in `@provino/types`. The spec is Track 2 R1–R2 and F3; B06's notes are in `docs/plan/bundles/B06.md`, B13c's (mocks in the loader, T2.5 + T4.8) in `docs/plan/bundles/B13c.md`.

## Two halves

- **Worker-wide: `src/internal/records.ts`.** Each user module has one `ModuleRecord` per worker:
  - transformed once: the `ModuleTransformer` (the pipeline, with the dialect's hoist policy), then `toModuleRunner` from `@provino/transform` for files with ESM syntax, or with only `import()` (format `unknown`, which a CommonJS `vm` script can't run);
  - its static deps resolved once; one that doesn't resolve is a `missing` target, thrown only when its edge runs (B13c Gap 7);
  - compiled once per mode with `vm.runInThisContext`, with `filename` set to the real path.

  `linkAsync`/`linkSync` walk the static graph. A record's `lateDeps` (D38) are never linked. Externals (anything under `node_modules` that `inline` doesn't match, plus addons and builtins) are shared by the worker: under `interopDefault: 'node'` the async path preloads them with native `import()` (Node's namespaces); under `babel` nothing is preloaded, and an edge `require`s the external when it runs, as Jest's CommonJS output does, so a mocked package never loads. `asyncGraph` marks top-level-await subgraphs, as a fixed point over cycles. `markAsyncGraphs` scans every record in the worker, so it runs only while `Records.asyncGraphsStale` is set: a new record, a record linked and every `resolved` write (through `setResolved`) set it, and the scan clears it.
- **Per file: `src/internal/registry.ts`.** A stack of instance maps; the top one is live, and `isolateModules` pushes a fresh one. Evaluation calls a record's compiled wrapper with fresh linkers, so module state is per registry while compiled code is shared. The registry carries the running file's `FileContext` (`{ mocks, scope }`); under `none` the registry is shared and each file sets its own.
  - `resetModules` empties every layer in place and keeps the stack's depth, so a reset inside `isolateModules` leaves the registry (under `none`, the worker's shared one) usable.
  - `isolate`/`isolateAsync` remove the map they pushed, by identity, not whatever is on top: overlapping async isolates each drop only their own map. The loader's `FileRegistry.isolateModules` also opens the module-mock registry's overlay, which refuses nesting with the dialect's `nested-isolation` text.

`src/loader.ts` holds `createLoader` and the tiers. `registry` creates a new `Registry` per file; `none` reuses one per loader.

`src/project.ts` holds `createProjectLoader(root, config, policy.module)`: the worker's way in. It builds the resolver and the transform pipeline from a clone-safe `SerializedLoaderConfig` (the worker entry may not import either; `config.hoist` is the dialect's hoist policy, by value), loads the config's mappers by `ModuleRef` (so it is async), and calls `createLoader` with the runner engine and `config.moduleScope`'s names. The transform cache is off until T3.6.

- **`tsconfig`:** `'auto'` and `false` pass through. Any other string is a file path, resolved against `root` (never the process cwd) for both the resolver and the pipeline, and it must be a file: otherwise `createProjectLoader` rejects with `LOADER_TSCONFIG_NOT_FOUND`, naming the resolved path.
- **Mappers:** each factory's result must be an object with a string `id` and a `map` function. A factory that throws (the error is the `cause`) or returns anything else rejects with `LOADER_INVALID_MAPPER`, naming `loader.mappers[<i>]`. Factories are called synchronously, as `ModuleMapperFactory` says.

`FileRegistry.invalidate(specifier, parent?)` drops the live instance of the user module the specifier resolves to, in the top map of an `isolateModules` stack. It resolves the specifier as an `import` and as a `require` and drops both ids, since a package's `exports` can map the two to different files and either may be the loaded one (a kind that doesn't resolve is skipped). Under `none` the registry is shared, so it reaches every file of the worker.

## Mocks (T2.5 + T4.8, B13c)

- **The worker builds the module-mock registry, not the loader** (Gap 1): it also needs the mock slice and the file's mock registry, which the loader never reads (non-negotiable 3). `FileRegistryOptions.moduleMocks` is a factory the loader calls once, with `{ loadActual, resolver, conditions }`. Without one, nothing is mocked and `registerMock`/`unregisterMock` throw `LOADER_NO_MODULE_MOCKS`. `FileRegistry.dispose` disposes it too.
- **Every edge decides.** A static import (`#importEdge`), a `require` (`requireFrom`, with the record's linked targets), an `import()` (`importFrom`) and a late import resolve, then ask `decide(id, importer, 'esm' | 'cjs' | 'builtin', specifier)`; a `missing` target asks `decideUnresolved` and throws its `ModuleNotFoundError` only if nothing stands in. A mocked edge gets `materialize`'s value: under `factoryShape: 'module-value'` an `import` sees it through the CommonJS interop; under `awaitFactory` a Promise is a result to wait for (`Pending`), which a sync edge refuses with `ERR_REQUIRE_ASYNC_MODULE`. The runner's own loads (`import`/`require` with no `parent`: setup files and the test file) never ask about the module itself.
- **The actual paths** (`requireActual`, `importActual`, and the registry's `loadActual`, which follows `ModulePolicy.actual`) bypass the mock of the module they name only; its own imports still decide. An ES module comes as its exports' view. `loadActual(id, importer, { scratch: true })` (automock) evaluates in a scratch instance map dropped afterwards, as Jest's `_generateMock` does; the registry swaps its mock values for the synchronous part.
- **Late imports (D38).** The hoister writes `await __provino_import__('./a')`; the wrapper passes `__provino_import__`. A record with late deps compiles in both modes as needed: `import` of it evaluates async (the `await` stays, so a late dependency with top-level await works), `require` of it, or a static import from a sync parent, evaluates sync with the `await` stripped, so `require()` of an ESM helper that hoists works as in Jest.

## Interop (`src/internal/interop.ts`, Gap 3)

Pure functions, by `ModulePolicy.interopDefault`, held to B13b's fake loader's rules by `interop.test.ts` (the mod corpus ran against them before the fake went):

- `esmExports`: an ES module's exports object. `babel`: a plain object with a hidden `__esModule`; `node`: a null-prototype `Module` namespace.
- `cjsNamespace(value, interop, cache)`: a CommonJS value (or a module-value mock) seen through `import`. `babel`: Babel's wildcard (a value with `__esModule` is its own namespace; otherwise `default` first, then the own enumerable keys, copied as they stand); `node`: every key sorted with `default` among them, `Module` tag. A `Module` namespace stays as it is. Built once per value (the registry's cache), except from a CommonJS module still evaluating.
- `actualView`: getters over the live exports; `babel` hides `__esModule` and sorts the names, `node` is a `Module` view in source order.

## Scope bindings (Gaps 2 and 5)

`LoaderOptions.moduleScope.names` (the dialect's, through `config`: Jest's `jest`) and, for ES modules under `injectCjsGlobals`, `require`, `__filename` and `__dirname`. A word scan at the first compile (`scopeOf`) keeps the names the source uses; a module that names none gets no outer function and pays nothing. A module that names one is compiled as `(function (jest, …) { return function (<wrapper params>) { … } })`, so its own `const require = …` shadows the binding instead of clashing with a parameter. The values come from `FileRegistryOptions.moduleScope(from)`, once per module evaluation; a name with no value falls back to the global of that name.

## Message codes (`src/internal/messages.ts`, Gap 4)

Read from `ModulePolicy.messages`, like the module-mock registry's. `transform-failed` (`{file}`, `{where}`, `{message}`; a code frame follows after a blank line; neutral `{file}{where}: {message}`, Jest `{file}: {message}`), `module-not-found` (`{specifier}`, `{from}` relative to the root, `{importer}`; Jest's is jest-resolve's), `unresolved-mock-import` (no neutral text; Vitest's profile appends ` imported from {importer}` when the test file's load fails on `unresolved-relative-mock`; an import from inside a test isn't wrapped). A not-found error is a `ModuleNotFoundError`, whose `name` stays `Error` (Node's and jest-resolve's are), code `MODULE_NOT_FOUND` for a `require` and `ERR_MODULE_NOT_FOUND` for an `import`.

## The wrapper shape (oxc's runner output, Vite's shape)

- **Imports** become `const __vite_ssr_import_N__ = await __vite_ssr_import__('./x', { importedNames })`. Uses become `__vite_ssr_import_N__.x`, which stays live.
- **Exports** become getters on `__vite_ssr_exports__`, hoisted above the imports, so cycles see live bindings.
- **`export *`** becomes `__vite_ssr_exportAll__(ns)`: one argument, bound to the module's own exports.
- **Other rewrites:** `import()` becomes `__vite_ssr_dynamic_import__`, and `import.meta` becomes `__vite_ssr_import_meta__`. The hoister's rewritten imports are `__provino_import__` calls.
- **Sync evaluation:** the plain `function` wrapper, with `await __vite_ssr_import__(` and `await __provino_import__(` stripped. Only `asyncGraph` modules, and an `import` of a module with late deps, use the `async function` wrapper. The compile listener fires once per wrapper compiled.
- **CJS** user files use Node's `(exports, require, module, __filename, __dirname)` wrapper. `require()` of an `asyncGraph` ESM module throws `ERR_REQUIRE_ASYNC_MODULE`.

## Not here yet (each throws `LOADER_NOT_IMPLEMENTED`, or is a stub)

| Piece | Task |
|---|---|
| Mock-aware auto-inlining (`LeakReport.inlinedForMocks` stays empty) | T2.6 (B13d) |
| Leak snapshot/restore (`dispose()` returns an empty `LeakReport`) | T2.7 |
| The `realm` tier | T2.8 |
| Source-mapped stacks and coverage: `onModuleCompiled` reports `wrapperColumnOffset` for each script | T2.9 |
| `tierFor` escalation by `@provino-isolate` (it returns the configured tier) | T2.11 |
| `engine: 'native'` and `provino-mock:` URLs | T2.10 |
| A semantics suite against native Node | T2.3 |

## Gotchas

- **The deprecated oxc runner transform aborts the process on unstripped TypeScript.** Only `toModuleRunner`, in `@provino/transform`, may call it, and only on the pipeline's output (DECISIONS D10).
- **A JSON module's `import * as`** gives `{ default }` only (Node's shape) under either interop; Babel's would carry the keys too. No golden pins it.
- **Tests:** `loader.test.ts` (tiers, interop, isolation, invalidate), `mocks.test.ts` (T2.5's contract: every edge decides, the actual paths, reset and isolation reach the registry, scratch, lazy misses, the message codes, D38, scope bindings, `none` with mocks, no registry), `internal/interop.test.ts`, `project.test.ts`.
- **Checks:**
  - `pnpm bench:loader check`: the Spike A fixture, 600/600 and 0 violations.
  - `pnpm bench:loader isolation`: registry overhead.
  - `pnpm bench:loader e2e`: vs Jest.
  - `packages/bench/src/loader/fixture.test.ts` runs the 600/600 check in `pnpm test`.
  - Against real Jest and Vitest: `@provino/harness`'s `mod-corpus.test.ts` (in-process and end to end).
