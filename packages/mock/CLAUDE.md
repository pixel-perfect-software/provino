# @provino/mock

The neutral mock engine (Track 4): mock functions, spies, replaced properties, stubs, and the per-file registry. It takes `MockPolicy`, never the whole `Policy`, and never asks which runner is active. A dialect supplies every value, including the words (`MockPolicy.messages`). Its only runtime import is `@provino/types`. B13a's notes are in `docs/plan/bundles/B13a.md`.

## Map

| Module | Role |
|---|---|
| `src/mock-fn.ts` | `createMockFn(policy, registry, options?)`, `isMockFunction`, `MOCK_BRAND`. The `MockSlot` holds all of a mock's state; `METHODS` are the shared methods; `buildLayout` caches a policy's frozen prototype and answers. |
| `src/registry.ts` | `createMockRegistry()`: the invocation counter, two `WeakRef` dirty sets, restorers, stubs, `clearAll`, `resetAll`, `restoreAll`, `beforeEach(cfg, between)`, `dispose`. The members tagged `@internal` are for this package's other modules. |
| `src/spy.ts` | `spyOn(policy, registry, object, key, access?)`, `replaceProperty(policy, registry, object, key, value)`. |
| `src/stubs.ts` | `createStubs(registry, env, global?)`. |
| `src/errors.ts` | `MockError` and `MockTypeError`: upstream's class and name, plus a `code`. |
| `src/module/registry.ts` | `createModuleMockRegistry(options)`: one per test file (T4.7). `register`, `decide`, `decideUnresolved`, `materialize`, `onResetModules`, `setAutomock`, `enterIsolation`/`exitIsolation`, `dispose`. See "The module registry" below. |
| `src/module/automock.ts` | `automock(value, shape, mode, mk)` (T4.6): `metadata` is jest-mock's `getMetadata` + `generateFromMetadata`, `deep` is `@vitest/mocker`'s `mockObject`; `automock` or `autospy`. |
| `src/module/manual-mocks.ts` | `findManualMock`, `findRootMock`: `__mocks__` discovery with `node:fs`. |
| `src/module/messages.ts` | The module registry's message codes and neutral text (`ModulePolicy.messages` overrides). |
| `src/module/test-support.ts` | Test only: `jestLike`/`vitestLike` module policies, a fake `Resolver`, `build()`. |
| `src/internal/messages.ts` | The message codes and the neutral text. |
| `src/internal/args-equal.ts` | `whenCalledWith`'s equality (this package can't import `@jest/expect-utils`). It answers what `equals(a, b, [iterableEquality])` answers, which `@provino/dialect-jest`'s `when-called-with-equality.test.ts` checks over a table. |
| `src/internal/test-support.ts` | `neutral`, and `flipped`: every key the other way. Not a claim about any runner. |

## Rules that aren't obvious

- **Creation has a 1 µs bar (T4.3), and these exist for it. Don't undo one without re-measuring:**
  - Methods are on a frozen prototype per policy, so a mock's only own string key is `mock`. `Object.keys(fn)` is `['mock']` (DIVERGENCES DV8).
  - The arity is in the source: `MOCK_CONSTRUCTOR_MAKERS` and `MOCK_MAKERS` are static function expressions for arities 0 to 9, one table per own name, as jest-mock's `matchArity` writes them, because `defineProperty(fn, 'length')` costs more than everything else. Nothing is compiled from a string, so creation works under `--disallow-code-generation-from-strings` (`src/internal/no-codegen.fixture.ts`, run in a child process by `mock-fn.test.ts`). Each maker is a plain closure over the slot and copies `arguments` with an indexed loop, so the call path looks up no `Array.prototype` or `Function.prototype` method (a spy on `slice` or `call` can't recurse). Arity above 9 does use `defineProperty`, and is exact, where jest-mock's `matchArity` gives 0.
  - The slot is assigned (`fn[SLOT] = slot`), so it's an enumerable symbol key, as jest-mock's own `Symbol.dispose` is. `lastCall`'s getter uses a shared descriptor, because a `get` in the literal costs about 330 ns (`local`).
  - Under an accessor `mock`, the arrays don't exist until the first read or call.
- **Creation touches no dirty set.** A mock joins one on its first call, first configuration change, or (under `clearReplacesStateObject`) first read of `.mock`. Those are the only ways a `clearAll` could be seen, which is why a read counts: `fn.mock` must change identity across `clearAll` even on a never-called mock.
- **A never-used `fn(impl)` isn't in a set, but `resetAll` must still drop its implementation under `resetTo: 'empty'`.** So `resetAll` bumps `registry.resets`, and a mock compares on first use (`catchUpOnResets`). Every path that reads or changes configuration while the mock isn't dirty goes through it.
- **`chain-to-impl` allocates only when it must.** An arrow has no `prototype`, so nothing is materialized. A `function` impl pays to materialize two prototypes at creation, which is what puts that one shape over the bar under such a policy (B13a report). It isn't deferred, because `mock.prototype.method` must work before the first `new`. Skipping the chain when `impl.prototype` holds only `constructor` was tried and reverted: it still read `impl.prototype` and measured about 1012 ns, against the 1 µs bar (`local`).
- **A method is an enumerable accessor on the frozen prototype.** `beforeEach(fn.mockClear)` and `const { mockReturnValue } = fn` are green upstream, so a method can't depend on `this`. The getter binds it to the mock on first read and caches it in the slot (`boundMethod`), so nothing per method exists at creation, `fn.mockClear === fn.mockClear`, and `length` survives (a `beforeEach` reads it to decide on `done`). `bind` prefixes `name` with `bound `, where upstream's own methods have the bare name. A read with no slot (the prototype itself) returns the unbound method, whose call throws `MOCK_DETACHED_METHOD`. The setter defines an own data property, so `fn.mockClear = x` works. `spy.ts`'s `findDescriptor` treats these accessors as the plain inherited methods they stand for. `boundMethod` binds with `Function.prototype.bind` and `Reflect.apply` captured at module load, so a spy on `bind` isn't inflated by reading a method.
- **`_isMockFunction` and `MOCK_BRAND` are accessors on the frozen prototype,** answering `true` only when the receiver has a slot (`undefined` otherwise). `Function.prototype.bind` gives a bound function the mock's prototype, so a plain `true` would make `f.bind(this)` look like a mock with nothing behind it, and `spyOn` would hand it back instead of wrapping it. `Object.create(mock)` children and `util.promisify` copies have the slot, so they still answer `true`. The setter defines an own data property, so `fn._isMockFunction = x` works. `findDescriptor` finds the brand as an own key of the prototype, which the accessor keeps.
- **`impl` has one "none": `undefined`,** as jest-mock's `mockImpl`. A `null` the caller passed is kept apart (the `whenCalledWith` dispatcher takes a branch on `impl !== undefined`). In a call, a queued `undefined` falls back to `impl` on a plain call and runs nothing under `new`; a queued `null` runs nothing (index.ts L805-L820). `currentState` recovers from any falsy `state` (`fn.mock = undefined`).
- **`resetMock` bumps a per-slot `epoch`,** and the restore `withImplementation` returns does nothing if the epoch moved, so a reset inside the callback (or during an async one) stays reset, as jest-mock's restore into a detached config does. `mockClear` doesn't bump it.
- **Under `newCall: 'construct'`, `invoke` writes the instance into `state.contexts` and `state.instances` as they are when the construction returns,** as @vitest/spy does (`state.contexts[contextIndex - 1] = returnValue`). A `mockClear` during the construction therefore leaves `calls: []` and the instance at index 0 of the new arrays, which real Vitest does too (the harness pins it). A throw writes nothing; a plain call never writes. Don't "fix" this by capturing the arrays at push time.
- **A spy under `spyReportsBridgeImpl` calls the original only through its bridge implementation,** as jest-mock's `spyOn` does: `slot.fallback` doesn't hold the original there, so `mockImplementation(undefined)` or a reset drops the call-through. Without a bridge (Vitest's policy) the original is `slot.fallback` and calls through whenever there is no implementation.
- **The slot is a symbol, not a `#private` field,** because a `Proxy` around a mock must keep working.
- **A restorer is registered after a successful install** (DV7), for spies and for `replaceProperty`. `restoreAll` runs every restorer even if one throws, then rethrows.
- **`mockRestore` leaves the restorer registered,** as both upstreams do, so `restoreAll` runs it again. It's idempotent unless the test reassigned the property in between.
- **Restorers run in registration order, on purpose (D32).** `spyOn(o, 'v', 'get')` then `spyOn(o, 'v', 'set')` then `restoreAll()` leaves the getter spy installed, because the second restorer captured a descriptor holding the first spy. Real Jest does the same. Reversing fixes that but changes `spy, mockRestore, reassign, spy, restoreAll`, which could turn a passing test red. Revisit if B16's pilot shows this biting.
- **`spyInstall` picks a whole flow,** not one line: `assign` is jest-mock's checks and messages, `define` is @vitest/spy's. Each code has one class, so the class doesn't need a policy key.
- **The superset API** (`mockThrow`, `whenCalledWith`, `withImplementation`) is on every mock under every policy (Track 4 L228, DV9). Only `mock`'s keys are per policy.

## The module registry (`src/module/`)

It takes `ModulePolicy` and `MockPolicy`, an injected `Resolver` (D34: this package never imports `@provino/resolver`) and `loadActual(id, importer)`, which also loads a manual mock's file. It never compares a runner's name.

- **Ids.** A file's id is its resolved path; a core module's is `node:<name>` (`os` and `node:os` are one); a virtual module's is `virtual:<specifier>`, with a relative specifier resolved against the importer. `ResolveResult`'s own `virtual` is Vite-host only (`virtual:<specifier>` stays inside the registry).
- **`register` resolves at once** (kind `mock`): no queue, no `flush` (Gap 4). A missing module needs `virtual` under `requireVirtualFlag`, or a root `__mocks__` entry; an `unmock` of a missing one is harmless. The error is `MockError` code `module-missing`, with `{specifier}` and `{from}` (relative to `roots[0]`). A file that resolves is never virtual, flag or not. Registering an id again replaces its entry and drops its cached value (Vitest's behaviour; Jest keeps the cached one, and no policy key says so yet).
- **`decide` is a pure lookup:** explicit unmock, explicit registration, automock-all (not core, not `unmockedPathPatterns`), root `__mocks__` when `rootMocksAutoApply` (never for a core module). The optional 4th argument is the specifier as written, for the root-mock name; without it the name comes from the last `node_modules` in the path, so `pkg/sub` is looked up as `pkg`. Jest's transitive `node_modules` rule (`applyTransitive`) is not built. `decideUnresolved` is for virtual ids and root-mocked packages that aren't installed. `MockDecision` has no `url` or `exportNames` (T2.10, Gap 5).
- **`materialize` caches per id** (the overlay first, then the file's map) and returns what the policy says: a Promise under `awaitFactory`, the factory's own value under `module-value` (a Promise stays the module), a Proxy only when `missingFactoryExport` is `throw` (so the Jest path pays nothing; `then`, `__esModule` and the well-known symbols read `undefined`). `namespace` refuses a function, array, `null` or primitive (`MockTypeError`, `factory-not-object`). A thrown factory error is wrapped only if the policy has a `factory-error` text (Vitest's hint, `cause` kept). A rejected Promise is evicted, so the next call runs the factory again.
- **Manual mocks.** `mock(p)` with no factory looks for a manual mock first: `<root>/__mocks__/<name>` (plain, scoped, core), then `__mocks__/<file>` beside the resolved file; a spy never does. An adjacent mock is applied by `decide` only after an explicit `mock()`; a root one applies by itself under `rootMocksAutoApply`. Roots are only `roots[i]/__mocks__` (Jest's haste map takes any `__mocks__` directory under a root).
- **`virtualRelative`.** When `false` (Vitest), a mock of a relative path that isn't on disk registers, but `decideUnresolved` throws the `unresolved-relative-mock` text (`Cannot find module '{id}'`, `{id}` root-relative with a leading `/`) at import time; a bare name works. Recorded by `mod-missing`, `mod-virtual`, `mod-virtual-static`.
- **A construction is `this instanceof` the mock,** not `new.target`: under `newCall: 'apply'` (jest-mock) the fallback runs through `apply`, so a class's per-instance method mocks came from nowhere until the check changed (`mod-automock-shape`, Jest).
- **Automock** goes through `loadActual` (a scratch registry is the loader's job, B13c), so the real module's side effects run, as in Jest. It may return a Promise, which `materialize` then returns.
- **`onResetModules`** drops every cached value under `resetModulesReRunsFactory` (the registrations stay, so it's still mocked), and the registrations too under `resetModulesClearsMocks`.
- **The overlay** (`enterIsolation(caller?, other?)`): reads cascade to the outer values, new values stay inside and go on `exitIsolation`. The two names fill the `nested-isolation` text. Registrations are global, as in Jest.

### `automock`

Both shapes: a function becomes a mock returning `undefined`; a class's constructor body never runs; each instance gets its own method mocks whose `fallback` is the prototype's mock, so a call records on both (`protoMethodCalls`); statics and nested objects are mocked; arrays become `[]`; `Map`s, primitives and `null` are kept; cycles resolve to the mock. The instance methods are made by the mock's `fallback`, so a `mockImplementation` on the class replaces that step (Jest runs it before the implementation).

- **`metadata`** (Jest): getters aren't slots, so they're absent (unless the object has `__esModule`); `Date`, `BigInt`, `Promise` and other unnamed kinds are dropped; `RegExp` becomes `new RegExp('')`; an ES module namespace gets a non-enumerable `__esModule`; a function's name is made safe as `_createMockFunction` does. A root with no metadata throws `automock-no-metadata`.
- **`deep`** (Vitest): a getter is an accessor returning `undefined`; `Date`, `RegExp` and `BigInt` are kept; symbol keys are mocked; the root is a plain object (a function root is a callable mock, which `mockObject` doesn't do).
- **`autospy`** keeps the real behaviour and getters, and (as `mockObject` does) patches nested objects in place.
- Goldens checked against by reading: `mod-automock-shape` (both runners). The harness's `mod-corpus.test.ts` is the real check.

## Message codes

Every code is in `internal/messages.ts` with the neutral text, and a policy's `messages` overrides any of them. An error's `code` is the message code upper-cased with `MOCK_` in front (`spy-missing` is `MOCK_SPY_MISSING`). `{key}`, `{type}` and `{name}` are filled in; `{word}` with no value stays. Two have no neutral text and do nothing unless a policy sets them: `new-not-a-constructor` (warns), `spy-read-only` (replaces V8's text, whose object description depends on the realm; `{tag}` is `Object.prototype.toString`'s).

## Tests

- `src/mock-fn.test.ts`, `registry.test.ts`, `spy.test.ts`: under `neutralPolicy.mock` and `flipped`.
- `src/module/registry.test.ts`, `automock.test.ts`, `manual-mocks.test.ts`: under `jestLike` and `vitestLike` (`module/test-support.ts`), with real temp directories for `__mocks__`.
- `test/mock.test-d.ts`: first-cut `fn`, `spyOn` and `replaceProperty` inference, with misuse; the registry, `findManualMock` and `automock`.
- Against real Jest and Vitest: `@provino/harness`'s `mock-corpus.test.ts`. The bar: `pnpm bench:mock --max-create-us 1 --max-call-ratio 1.5`.

## Not built yet

- Wiring the registry into the loader and the shipped `jest.mock`/`vi.mock` (T4.8, B13c). `createMockFn` doesn't sanitize `name`; `automock` does, under `metadata`.
- `JestMock`, `Mocked*` and the second type view (T4.5). The types are a first cut.
- Cleanup between tests in a real run (T4.10): the worker calls `registry.beforeEach`.
- A Vitest facade must convert `stubEnv`'s `PROD`/`DEV`/`SSR` booleans to `'1'`/`''` before calling `createStubs`, as Vitest 5.0 does, because the engine takes strings.
- The engine uses the host's `Promise` (`mockResolvedValue`, settled results), where jest-mock uses `_environmentGlobal.Promise`. That matters once a vm-realm environment runs tests (B17).
