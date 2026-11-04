# @provino/core

The test runtime (Track 5): collector, executor, hooks, the test context and the current-test lookup. It runs in the worker, reads only `CorePolicy`, and never imports the loader: the caller passes an `ImportFile` (Track 1 §Module boundaries, rule 6). Every Jest/Vitest difference is a `CorePolicy` value; there is one code path. B07's notes are in `docs/plan/bundles/B07.md`.

## Map

| Module | Role |
|---|---|
| `src/runtime.ts` | `createRuntime(options)`: loads `formatEachTitle`/`orderHooks` through the `BehaviourLoader` first (so registration stays sync), builds one `Deadlines`, wires the parts. `runFile(path, { lines?, testNamePattern?, testIds? })` (the last two replace the runtime's for that file only) collects, runs the `onCollected` listeners, finalizes, runs, then always drains the file teardowns and emits `file-end`; a second `runFile` while one is active rejects with `CORE_BUSY`. `dispose()` drains the worker teardowns |
| `src/collector/collector.ts` | Registration into a mutable tree (`internal/model.ts`): modes, options inheritance, immediate/deferred bodies, async bodies, nested and late registration |
| `src/collector/finalize.ts` | After collection: ids, full names, `dupIndex`, the two **focus algorithms**, filters (name, ids, lines), `allowOnly`, `emptyDescribe`, the clone-safe `TaskNode` list |
| `src/collector/api.ts` | The chainable global API (`RuntimeApi`): `describe`/`test` modifiers, `.each`/`.for`/tables, hooks |
| `src/executor/executor.ts` | The suite walk, concurrency groups, the per-attempt pipeline, hooks, teardowns, callbacks |
| `src/executor/around.ts` | `aroundEach`/`aroundAll` (Vitest 5.0's `callAroundHooks`) |
| `src/executor/deadline.ts` | The one owner of time limits: `createDeadlines` (every bounded call and teardown drain, the `CORE_TIMEOUT` messages, aborting the attempt's signal), `resolveTimeout` (`timeouts.zero`), `armDeadline`. A sync call takes no timer; 0, non-finite and > 2^31−1 ms mean no deadline |
| `src/executor/{limiter,invoke,context}.ts` | The `maxConcurrency` semaphore, calling user functions (`done`, generators, `nonPromiseReturn`, Jest's shared `this`), the `TestContext` |
| `src/collector/{nodes,location,each}.ts` | Node constructors and the flat `walk`; lazy locations (`locationFrame`); `.each` tables (`collect.eachTableError`) |
| `src/internal/` | `model.ts` (the mutable tree, `Store`, `AttemptState`), `thenable.ts`, `test-support.ts` (test helpers; exempt from the boundary lints, importable only by tests) |
| `src/current/current-test.ts` | The **only** `node:async_hooks` import: one `AsyncLocalStorage`, built when core loads (never lazily: Track 5 Spikes A), `currentTest`, the sync `running()` pointer |
| `src/lazy-host.ts` | The `LazyHost` `@provino/lazy` builds on; its header lists the 4 guarantees |

## How things fit

- **One store per test attempt.** `runInStore(store)` covers the attempt's each-hooks, body and teardowns; each hook runs in a child store that shares the attempt's `lazy` frame object, so `LazyHost.current()` is the same frame throughout an attempt (guarantee 1). `currentTest.get()` reads the store's `frame` (it carries the hook kind). Suite hooks get a `suite` frame.
- **The per-attempt order** is in `executor.ts`'s header: aroundEach (every level's, outermost first) wraps beforeEach (parent → child) → body → afterEach (child → parent) → the teardowns `beforeEach` returned (once, after *all* levels' afterEach) → `LazyHost` teardowns → `onTestFinished` (last first) → `onTestFailed`. Recorded from the real runners; Track 5's line 81 (teardowns per level) is wrong for `beforeEach`.
- **Two focus algorithms** (`focus.scope`): `file` copies jest-circus 30.5 (describes pass their mode to tests that declare none, unless a describe.only has a direct test.only; `.only` anywhere narrows the whole file); `suite` copies Vitest 5.0's `interpretTaskModes`. The final mode is on the node (`mode`); `TaskNode.mode` keeps the declared one.
- **A skipped suite** never runs its own hooks but still walks its children (so Jest's describe.only inside describe.skip runs). Whether a running suite's `beforeAll`/`afterAll` run is `hooks.skippedBlock`: `run-before-all` is jest-circus's `hasEnabledTest` (a todo counts); `none` is Vitest's suite collapse (an empty suite still runs its hooks).
- **Collection failures** (an import that throws, an async describe under `asyncDescribe: 'throw'`, …) report no tasks and fail the file, as both runners do (`crashed` in a golden).
- **Locations** are captured at registration (3 frames, or 10 under `locationFrame: 'test-file'`) and parsed once when the tree is built, hooks included; off with `locations: false`. `'caller'` takes the first frame (Jest), `'test-file'` the first frame in the test file (Vitest).
- **`.failing`/`.fails`** (`status.expectFail`): `'body'` reverses the body's result in `#runBody`; `'attempt'` reverses the whole attempt after the around chain, and `onTestFailed` runs from the real result before that.
- **Late registration** is the collector's call: it charges the suite's own file (`collect.lateRegistration`) and the runtime only emits the `unhandled-error` event.

## Testing

- `src/**/*.test.ts`: unit tests, one case per policy value, through `internal/test-support.ts`'s `runScript` (an inline "file" under the neutral policy plus overrides). No real-time waits: timeouts use an injected fake clock (`realTimers`, `now`).
- `src/current/propagation.test.ts`: the 23 propagation cases (Track 5 Spikes B). Cases 20–21 run in a child process (`fixtures/process-listeners.ts`), because `node:test` installs its own process handlers.
- **Ground truth against the real runners** lives in `@provino/harness`: `src/runtime-corpus.test.ts` runs every `fixtures/runtime/` fixture through `createRuntime` under each recorded profile (`src/runtime-corpus/profiles.ts` holds the jest / vitest-stack / vitest-list values until B14's dialects replace them) and compares trace, tests, locations and file status with the golden.
- `test/core.test-d.ts`: the public API, and T6.1's check that `Runtime['lazyHost']` satisfies `LazyHost` (§4 D.23).

## Not built yet (each throws `CORE_NOT_IMPLEMENTED` or is absent)

- `ctx.skip`, `ctx.annotate`, `onBeforeTryTask`/`onAfterTryTask`, and `ctx.task.result`: T5.8. `ctx.task` is the clone-safe `TestTask`.
- Jest's exact `done` errors and the callable context: T5.7. B07's `done` is basic: a call passes, an argument fails.
- Exact `.each` titles: T5.4 (core calls the policy's `formatEachTitle`; truncation belongs there).
- `retry.timing: 'deferred'`, retry `delay`/`condition`, `jest.retryTimes`: T5.10. Immediate `retry`/`repeats` work.
- Process-level error attribution (`errors.lateErrors`): T5.11. Bail and cancel: T5.12. `describe.shuffle`: T5.13. The overhead gate: T5.14. The definition table: T5.9. Tag filters.
- Messages are neutral, not the dialects' text (timeouts, `.only` on CI, empty describes); the dialects own exact text (B14).
- `aroundEach`/`aroundAll` don't take a `limitHooks` slot (Vitest holds one through each phase).
- A bad `describe.each` table under `collect.eachTableError: 'failing-test'` registers one failing test; real Jest fails the whole file. B14 records a fixture and decides (fix, or DIVERGENCES).
- The overhead target (≤ 5 µs per empty test with 3 hooks and ALS, T5.14) isn't met yet: 7.9 µs/test with locations off, 14.7 with them on (`local`, after the B07 cleanup). Stack capture at registration is most of the locations-on cost.
