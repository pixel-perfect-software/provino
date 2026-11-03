# @provino/expect

The neutral `expect` engine (Track 7 R1). It owns the front end, the per-test matcher state and the global matcher slot. A dialect supplies everything else through an `ExpectTable` (`@provino/types` `expect.ts`): the matchers, the asymmetric matchers, `this.utils`, and every word the engine prints. `ExpectPolicy.matcherTable` is a `ModuleRef` to the dialect's table factory. B08's notes are in `docs/plan/bundles/B08.md`.

## Map

| Module | Role |
|---|---|
| `src/expect.ts` | `createExpect({ policy, table, source, registry? })`. `expect(x)` returns a Proxy that resolves `not`/`resolves`/`rejects` and the matcher name on access (spike F). A call follows Jest's `makeThrowingMatcher` (`expect/src/index.ts` L275–L395) step by step. `MatcherResultError` is the `errorShape: 'matcher-result'` error (Jest's `JestAssertionError`). |
| `src/state.ts` | `createStateSource(currentTest, { nameSeparator, expand })`: the file's state, plus one state per test attempt, keyed by test id and refreshed when the attempt number changes. It takes `@provino/types`' `CurrentTest`, so core is never imported. |
| `src/slot.ts` | `installMatchersSlot(source, registry)`: `globalThis[Symbol.for('$$jest-matchers-object')]`, configurable. Its `matchers` and `customEqualityTesters` are the registry's own objects, and its `state` getter returns `source.current()`. |
| `src/asymmetric.ts` | The `AsymmetricMatcher` base (T7.4), for Provino and user code; Jest's vendored built-ins keep their own base. `getMatcherContext()` reads whichever slot the realm has. |
| `src/context.ts` | `MatcherContext`, a matcher's `this`. |
| `src/internal/slot-read.ts` | Reading the slot without owning it. |

## Rules that aren't obvious

- **Every error the engine makes or rethrows is anchored with `Error.captureStackTrace` above its own frames.** Our source runs from `packages/*/src`, which the harness reads as user code (only `node_modules/` frames are internal). Without the anchor, `userFrame` would point into the engine. The expect corpus compares `userFrame`, so a missing anchor fails it.
- **The error a wrong settlement throws** (`.resolves` on a rejection, `.rejects` on a resolution) is made in `expect()`, as Jest does, so it points at the `expect(` column. Only a function or a native promise (`util.types.isPromise`, which reads no property of the value) pays for that stack. Any other thenable gets its error when `.resolves`/`.rejects` is read.
- **Jest's tick counts are kept:** a thenable's own `.then`, then `.catch` on what it returns, with no `Promise.resolve` wrapping. Extra ticks would change races with a test's end (the policy corpus' unawaited cases).
- **`getMessage` keeps Jest's `(message && message())`.** A falsy `message` means "no message", and a string one throws `message is not a function`. The local is named `message` so V8 prints that text.
- **The state is per attempt, not one global.** A new attempt copies the file state (so `expand`, `testPath` and keys set in `beforeAll` carry over) and resets the counters. A key a test sets with `setState` stays in that attempt, where Jest would leak it to later tests (B08 notes).
- **Built-in matchers are tracked in a `WeakSet`**, not with Jest's `$$jest-internal-matcher` property on the function. The table's `promiseMatchers` aren't internal, because Jest's `getPromiseMatcher` returns fresh, unflagged functions.

## The worker's boot order (U1)

1. `createStateSource(currentTest, { nameSeparator: core.nameSeparator, expand: expect.expand })`
2. `createMatcherRegistry()`, then `installMatchersSlot(source, registry)`, before any matcher module loads.
3. Load the table from `policy.expect.matcherTable` through the `BehaviourLoader`.
4. `createExpect({ policy, table, source, registry })`.
5. Per file, `source.startFile(testPath)`, then the setup files and the test file.

Per test, `source.stateOf(testId)` gives the counts the result needs (`numPassingAsserts`). Core reports 0 until U1 wires this.

## Not built yet

- `createExpect` throws `EXPECT_NOT_IMPLEMENTED` for:
  - `errorShape: 'assertion-error'` (T7.6);
  - `equality.errors: 'assert'` and `invalidDate: 'equal'` (T7.7);
  - `soft`, `poll` and `requireAssertions` (T7.8).
- `matcherTable: null` throws `EXPECT_NO_MATCHER_TABLE`: the neutral table has no owner yet.
- The end-of-test checks for `extractExpectedAssertionsErrors`/`assertions`/`hasAssertions`, and `suppressedErrors` reaching the result: T7.8. `assertions`/`hasAssertions` only set state today.
- Snapshot matchers: T7.10. The augmentable registry and bridges: T7.13. The ban list: T7.12. The per-file slot swap for mixed dialects: T7.17.

## Testing

- `src/*.test.ts` run against `internal/test-support.ts`'s neutral `testTable()`, never a dialect.
- `interop-jest.test.ts` and `interop-vitest.test.ts` are spike C, both ways. Each runs in its own process, because `expect@30.5.2` and `@vitest/expect@5.0.5` each define the realm's slot when they load.
- Jest-dialect behaviour is checked in `@provino/dialect-jest` (spike E, slot order) and `@provino/harness` (`expect-corpus.test.ts`).
