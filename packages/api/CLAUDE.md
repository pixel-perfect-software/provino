# @provino/api

The native test API (B27, D185, D186): what `import { describe, it, expect, … } from 'provino'` binds in a project with no dialect, and the same values as globals under `globals: true`. Private, inlined into `provino` (it ships as the worker entry `worker/api`). Every value is built over the worker's host, which carries the policy slices the engines read (`host.mockPolicy`, `host.timersPolicy`); the neutral policy decides what they do. Its public surface is a frozen API object per worker, the served-module scope, and one error class. How `provino` wires it (the refs, the served namespace, the hoist policy, the slot, the module mocks end to end) is in `packages/provino/CLAUDE.md` → "The native API"; this file is the package's own map.

## Layer

Layer 5, runs in the **worker**, neutral (`tooling/boundaries/packages.json` owns what it may import; `core` is types only). It never imports a dialect and never names `'jest'` or `'vitest'`; it loads nothing from Jest or Vitest (`bannedPackages: "native"`). Only `provino` imports it, through the refs it hands `@provino/config` (`NativeRuntimeRefs`: `packages/provino/src/internal/built-ins.ts`), so nothing here crosses a thread as a closure.

## Map

| File | Role |
|---|---|
| `src/index.ts` | The public entry: the factories, the slot key, the served specifier, `uninstallProvinoApi`, `ProvinoApiError`, `PROVINO_MODULE_MOCK_NAMES` and the types. `moduleMocksOver` is not exported (`@internal`). |
| `src/types.ts` | `ApiHost` (`GlobalsHost` with the real types of the objects it declares as `object`: `api: RuntimeApi`, `expect: ReturnType<typeof createExpect>`, `mocks(): MockRegistry`, `timers(): FakeClock`), `ProvinoApi` (a type alias, so it is a `GlobalsFactory`'s record), `ProvinoGlobalsApi` (`ProvinoApi` without the module-mock names), `ProvinoSpyOn`, `ProvinoMocks`, `ProvinoTimers`, `ProvinoMock`, `ProvinoMockFactory`. |
| `src/scope.ts` | `provinoModuleScope(host)`, `provinoGlobals(host)`, `uninstallProvinoApi(api)`, `PROVINO_API_SLOT` (`Symbol.for('provino.api')`), `PROVINO_SERVED_MODULE` (`'provino'`), `ProvinoModuleScope`, and the per-host `built(host)` they share. |
| `src/module-mocks.ts` | `mock`, `unmock` and `importActual` over the file registry (`moduleMocksOver(host, from)`), `PROVINO_MODULE_MOCK_NAMES`, and the factory guard. |
| `src/module-registry.ts` | `resetModules`, `isolateModules` and `isolateModulesAsync` (B28, D215): each reads `host.registry()` when called and calls `FileRegistry.resetModules/isolateModules/isolateModulesAsync`; an isolation returns its callback's value, and a nested one surfaces the module-mock registry's `MockError` `nested-isolation`. In the API object and the globals. |
| `src/errors.ts` | `ProvinoApiError` and `ProvinoApiErrorCode`. |

## What each factory builds, and what it reads from the host

- **`built(host)`** builds the API once per host (a `WeakMap`, so a second call returns the same objects) and installs it at `globalThis[Symbol.for('provino.api')]` (configurable, non-enumerable, read-only). The slot is for code the loader doesn't serve: a `node_modules` helper that Node loads itself reaches `provino`'s `src/index.ts` forwarders, which read the slot first, then the globals. The slot's object holds no lazy variables; those forwarders read the lazy runtime's own slot.
- **The test members come straight from `host.api`** (core's `RuntimeApi`): `describe`, `suite`, `it`, `test`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `aroundEach`, `aroundAll`, `onTestFinished`, `onTestFailed`. `it` and `test` are typed `FixtureTestApi` because the neutral policy exposes `extend` (`definitions.extendApi: 'expose'`). `expect` is `host.expect`.
- **The mock members read the file running now when called, not when the factory runs** (each file has its own registry, and under isolation `none` the worker has one): `fn`, `spyOn`, `replaceProperty` and `isMockFunction` close over `host.mockPolicy` and `host.mocks()`; `mocks.clearAll/resetAll/restoreAll` call `host.mocks()`.
- **`timers`** is `createTimerMembers(() => host.timers(), host.timersPolicy, () => timers)`, frozen: the neutral `facadeReturns: 'all'` makes every member that changes the clock return this object.
- **`mock`, `unmock`, `importActual`** (`module-mocks.ts`) go through `host.registry()` (`registerMock`, `unregisterMock`, `importActual`, and `tier` and `file` for the shared-module check), so a registration lives and dies with its file. They resolve a specifier **from the module that called them**, which is why the served module is built per importing module (below) and why they are never globals (a global `mock` would not be hoisted). The slot's copies have no module and resolve from the test file running now. No factory is the neutral automock (`{ kind: 'automock', spy: false }`); a function is a factory, wrapped by `guarded`.
- **`mocked`** (B28) is the identity function in the API object (served and a global). **`requireActual`** is a module-mock member beside `importActual` (`PROVINO_MODULE_MOCK_NAMES`, never a global): `assertSpecifier`, then `FileRegistry.requireActual` from the calling module (sync, `require` semantics, `ERR_REQUIRE_ASYNC_MODULE` for a graph with top-level await).
- **`provinoGlobals(host)`** returns `built(host).globals`: the same objects without `mock`, `unmock` and `importActual`. It never holds the lazy variables.

## The served module (`provinoModuleScope`)

`NativeRuntimeRefs.moduleScope` calls it once per worker; the loader then answers an import of `provino` before resolution. The result is a function from the importing module's path to a scope: a frozen object with **no binding names** (`Object.keys` is `[]`, so a native file gets the API only by importing it) and one non-enumerable key, `provino`, holding the module's namespace. The namespace is built on a module's first import and is the same object after: `{ ...api, ...moduleMocksOver(host, from), ...LAZY_EXPORTS }`. Every value but the three module-mock members is the worker's one object, so `expect === expect` across a file's modules, and a served import is direct bindings, with no Proxy and no per-call lookup (D115, `speed`); only the registries and the clock, which each file has its own of, are read when a member is called. `LAZY_EXPORTS` are `provino`'s own lazy functions and `LazyError`, which read the lazy runtime's slot when called.
## Error codes

`ProvinoApiError` (`code`, then the message), thrown where the call is made (a factory's, when it runs):

- `API_MOCK_SPECIFIER`: `mock`, `unmock` or `importActual` got a specifier that is not a string.
- `API_MOCK_FACTORY`: `mock` got something other than a function (or nothing) as its factory.
- `API_MOCK_FACTORY_UNINITIALIZED`: a factory read a binding in its dead zone (it runs while the file's imports load). `guarded` rethrows V8's `ReferenceError` with the binding as the user wrote it (the hoister's `__provino_import_N__` late imports are read back to the import's export name) and the original as `cause`; any other error passes through, and an async factory's rejection is read the same way.
- `API_MOCK_SHARED_MODULE`: `mock` or `unmock` called from a module other than the test file under isolation `none`, which loads that module once per worker, so the mock would reach only the first file.

## Tests

- `src/scope.test.ts`: the factories against a fake host (`fakeHost(tier)`: each entry of `host.api` is a distinct function so the test can tell which one a namespace holds, `next()` moves "the file running now" to a new mock registry and clock, and a stand-in file registry records the module-mock calls). It holds the namespace and the slot, the globals, `fn`/`spyOn`/`replaceProperty`/`mocks`/`timers` acting on the file running now, the slot's removal at stop, and each error code. It uses `neutralPolicy`'s `mock` and `timers` slices.
- `test/api.test-d.ts` (`pnpm test:types` and `pnpm test:types:ts5.9`): the factories extend `ModuleScopeFactory` and `GlobalsFactory`, the module-mock names are not in `ProvinoGlobalsApi`, `uninstallProvinoApi` takes the API, and each misuse is a `@ts-expect-error` line.
- What runs the factories in a real worker is `provino`'s: `packages/provino/test/native-api.test.ts`, `packages/provino/test/native-mocks.test.ts`, `packages/provino/src/internal/built-ins.test.ts` (which holds `PROVINO_SERVED_MODULE` equal to `NATIVE_RUNTIME.modules` and the hoist policy's modules), and `packages/provino/src/index.test.ts` (the slot-then-globals order). Which runner runs a file: `.claude/rules/tests.md`.

## Not built

- No `before`/`after` aliases for `beforeAll`/`afterAll` (D190: the node:test codemod renames them).
- No global `mock`, `unmock` or `importActual`, and no lazy variables as globals: the first would not be hoisted, the second are always imported.
- No hoisting here: moving a top-level `mock` above the file's imports is the transform's, under `@provino/policy`'s `nativeHoistPolicy('provino')`, which `provino` passes through `NativeRuntimeRefs.hoist`. A `mock` inside a function or block fails the file with `HOIST_NOT_TOP_LEVEL`.
- No matcher table: `expect` is the worker's `createExpect`, and the table it holds comes from `@provino/expect/table` (`NativeRuntimeRefs.matcherTable`).
- No API report here: the package is private and inlined (it is not in `SEMVER_PACKAGES`), so only `provino`'s own report (`packages/provino/etc/provino.api.md`) could promise any of it.
