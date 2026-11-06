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
| `src/internal/messages.ts` | The message codes and the neutral text. |
| `src/internal/args-equal.ts` | `whenCalledWith`'s equality (this package can't import `@jest/expect-utils`). It answers what `equals(a, b, [iterableEquality])` answers, which `@provino/dialect-jest`'s `when-called-with-equality.test.ts` checks over a table. |
| `src/internal/test-support.ts` | `neutral`, and `flipped`: every key the other way. Not a claim about any runner. |

## Rules that aren't obvious

- **Creation has a 1 µs bar (T4.3), and these exist for it. Don't undo one without re-measuring:**
  - Methods are on a frozen prototype per policy, so a mock's only own string key is `mock`. `Object.keys(fn)` is `['mock']` (DIVERGENCES DV8).
  - The arity is in the source: `compileMaker` compiles one function maker per name and arity (0 to 9), because `defineProperty(fn, 'length')` costs more than everything else. Arity above 9 does use `defineProperty`, and is exact, where jest-mock's `matchArity` gives 0.
  - The slot is assigned (`fn[SLOT] = slot`), so it's an enumerable symbol key, as jest-mock's own `Symbol.dispose` is. `lastCall`'s getter uses a shared descriptor, because a `get` in the literal costs about 330 ns (`local`).
  - Under an accessor `mock`, the arrays don't exist until the first read or call.
- **Creation touches no dirty set.** A mock joins one on its first call, first configuration change, or (under `clearReplacesStateObject`) first read of `.mock`. Those are the only ways a `clearAll` could be seen, which is why a read counts: `fn.mock` must change identity across `clearAll` even on a never-called mock.
- **A never-used `fn(impl)` isn't in a set, but `resetAll` must still drop its implementation under `resetTo: 'empty'`.** So `resetAll` bumps `registry.resets`, and a mock compares on first use (`catchUpOnResets`). Every path that reads or changes configuration while the mock isn't dirty goes through it.
- **`chain-to-impl` allocates only when it must.** An arrow has no `prototype`, so nothing is materialized. A `function` impl pays to materialize two prototypes at creation, which is what puts that one shape over the bar under such a policy (B13a report). It isn't deferred, because `mock.prototype.method` must work before the first `new`. Skipping the chain when `impl.prototype` holds only `constructor` was tried and reverted: it still read `impl.prototype` and measured about 1012 ns, against the 1 µs bar (`local`).
- **A method is an enumerable accessor on the frozen prototype.** `beforeEach(fn.mockClear)` and `const { mockReturnValue } = fn` are green upstream, so a method can't depend on `this`. The getter binds it to the mock on first read and caches it in the slot (`boundMethod`), so nothing per method exists at creation, `fn.mockClear === fn.mockClear`, and `length` survives (a `beforeEach` reads it to decide on `done`). `bind` prefixes `name` with `bound `, where upstream's own methods have the bare name. A read with no slot (the prototype itself) returns the unbound method, whose call throws `MOCK_DETACHED_METHOD`. The setter defines an own data property, so `fn.mockClear = x` works. `spy.ts`'s `findDescriptor` treats these accessors as the plain inherited methods they stand for. `_isMockFunction` and `MOCK_BRAND` stay plain data.
- **The slot is a symbol, not a `#private` field,** because a `Proxy` around a mock must keep working.
- **A restorer is registered after a successful install** (DV7), for spies and for `replaceProperty`. `restoreAll` runs every restorer even if one throws, then rethrows.
- **`mockRestore` leaves the restorer registered,** as both upstreams do, so `restoreAll` runs it again. It's idempotent unless the test reassigned the property in between.
- **`spyInstall` picks a whole flow,** not one line: `assign` is jest-mock's checks and messages, `define` is @vitest/spy's. Each code has one class, so the class doesn't need a policy key.
- **The superset API** (`mockThrow`, `whenCalledWith`, `withImplementation`) is on every mock under every policy (Track 4 L228, DV9). Only `mock`'s keys are per policy.

## Message codes

Every code is in `internal/messages.ts` with the neutral text, and a policy's `messages` overrides any of them. An error's `code` is the message code upper-cased with `MOCK_` in front (`spy-missing` is `MOCK_SPY_MISSING`). `{key}`, `{type}` and `{name}` are filled in; `{word}` with no value stays. Two have no neutral text and do nothing unless a policy sets them: `new-not-a-constructor` (warns), `spy-read-only` (replaces V8's text, whose object description depends on the realm; `{tag}` is `Object.prototype.toString`'s).

## Tests

- `src/mock-fn.test.ts`, `registry.test.ts`, `spy.test.ts`: under `neutralPolicy.mock` and `flipped`.
- `test/mock.test-d.ts`: first-cut `fn`, `spyOn` and `replaceProperty` inference, with misuse.
- Against real Jest and Vitest: `@provino/harness`'s `mock-corpus.test.ts`. The bar: `pnpm bench:mock --max-create-us 1 --max-call-ratio 1.5`.

## Not built yet

- Automock (T4.6), `ModuleMockRegistry` (T4.7, T4.8; B13b goes in `src/module/`). `CreateMockOptions` has `name`, `length` and `fallback` for them. `name` isn't sanitized: jest-mock's `_createMockFunction` rewrites reserved words and characters, and an automock that needs that does it first.
- `JestMock`, `Mocked*` and the second type view (T4.5). The types are a first cut.
- Cleanup between tests in a real run (T4.10): the worker calls `registry.beforeEach`.
