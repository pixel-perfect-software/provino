# @provino/timers

The neutral fake clock (Track 4, T4.9): one `FakeClock` per environment global over `@sinonjs/fake-timers` 15.4.0, and the timer members of the `jest` and `vi` objects built on it. It takes `TimersPolicy`, never the whole `Policy`, and never asks which runner is active; a dialect supplies every value, including the words (`messages.notFaked`). Its only third-party dependency is `@sinonjs/fake-timers` (exact, through the catalog). B17a's notes are in `docs/plan/bundles/B17.md`.

## Map

| Module | Role |
|---|---|
| `src/clock.ts` | `createFakeClock(env, policy, { bind?, defaults? })`: `install`, `uninstall`/`dispose`, the advance family, `setSystemTime`, `mockedSystemTime`, `now`, `reset`, `setTickMode`. Rebuilt from `@jest/fake-timers` 30.5.2 `modernFakeTimers.ts` and Vitest 5.0.5 `integrations/mock/timers.ts`. |
| `src/members.ts` | `createTimerMembers(clock, policy, facade)`: every timer member `jest` or `vi` has, over a getter for the clock of the file running now. A dialect copies the names it has. |
| `src/types.ts` | `FakeClock`, `FakeTimersConfig`, `FakeMethod`, `TimerTickMode`, `TimerMemberName`. |
| `src/errors.ts` | `TimersError` and its codes: `TIMERS_NOT_FAKED`, `TIMERS_LEGACY_UNSUPPORTED`, `TIMERS_INVALID_TICK_MODE`. |
| `src/internal/test-support.ts` | `neutral`, `flipped`, and `makeEnv`: a stand-in global, so a test never fakes the timers `node:test` runs on. |

## Rules that aren't obvious

- **One implementation, every difference a policy value.** The default set is `toFakeDefault` (Vitest leaves `nextTick` and `queueMicrotask` real) minus `Temporal` when `fakeTemporal` is off. The option names are `optionNames`: `do-not-fake` reads Jest's `doNotFake`, `advanceTimers`, `timerLimit`, `legacyFakeTimers`; `to-fake` reads Vitest's `toFake`, `toNotFake`, `shouldAdvanceTime`, `advanceTimeDelta`, `loopLimit`, `shouldClearNativeTimers`; each ignores the other's, as each runner does. `loopLimit` is the default for the limit. `advanceToNextTimerHonorsSteps: false` makes `next(steps)` run one slot (Vitest's `vi` takes no steps).
- **Real timers.** An advance call while timers are real warns (Jest) or throws (Vitest) with `messages.notFaked`; a `{stack}` in the text is replaced by the call's stack frames, which is how Jest's text ends. `setSystemTime` while real is `warn-noop` (Jest: warns, does nothing) or `fake-date-only` (Vitest: fakes `Date`, and `Temporal` with `fakeTemporal`, until `uninstall`; a later `install` starts from that time and drops the Date-only clock).
- **Legacy timers are not built** (Q4.1). `legacyFakeTimers: true` under `legacyAvailable` throws `TIMERS_LEGACY_UNSUPPORTED` when a test installs them, and costs nothing in a config that names it but never fakes (styled-components' base config). Under a policy with no legacy timers the option is ignored, as Vitest ignores it. The timer corpus declares it (`DV-B17a-legacy-timers`).
- **Each callback is bound to the test that scheduled it.** After `install`, the faked schedulers (`setTimeout`, `setInterval`, `setImmediate`, `requestAnimationFrame`, `requestIdleCallback`, `queueMicrotask`, `nextTick`) are wrapped so that `bind(callback)` (`CurrentTest.bind`, an `AsyncLocalStorage.bind`) runs the callback in the context it was scheduled in. A fake timer otherwise fires from `tick()`, in whoever called `tick()` (build-plan §6 L793, which replaces T4.10's non-ALS fallback). The wrapper keeps the fake's own properties (`.clock`, `util.promisify.custom`). Timers made through `node:timers` or `timers/promises` are sinon's own, unbound.
- **A `Temporal.Duration` is converted by the clock** (`total({ unit: 'millisecond' })`) before it reaches sinon, as Jest does, so Node 24's partial `Temporal` doesn't matter (Vitest passes it through and fails on Node 24).
- **`advanceTimersToNextTimerAsync`** ticks `0` with `tickAsync`, as Jest does; Vitest's sync `tick(0)` there is a known, unobservable difference (B17a's DIVERGENCES draft).

## Testing

- `src/clock.test.ts`, `src/members.test.ts`: every policy value on a stand-in global (the Temporal cases use a stub `Temporal`), the async-context binding, the facade returns.
- `src/dom-raf.test.ts` (T4.9's last Done-when clause, B17c): a jsdom window and a happy-dom `GlobalWindow` are each the clock's own global (`createFakeClock(window, policy)`, so no real timer is faked and no environment package is needed), and `window.requestAnimationFrame` is faked, advanced a frame at a time, cancelled and put back. The same through the real environment is `provino`'s `test/env-jsdom.test.ts` (`jest.useFakeTimers()` in a worker).
- `test/timers.test-d.ts`: the public types and misuse (a wrong option name, a string for milliseconds, a tick mode outside the three).
- Against the real runners: `@provino/harness`'s `timer-corpus.test.ts` runs the 8 `fixtures/mocking/timers-*` fixtures (48 cases per runner) in a child process, because the clock fakes that process's own timers; and `@provino/dialect-jest`'s `runtime/timers.test.ts` and `provino`'s `test/runtime.test.ts` (through `run()`).

## Not built yet

- Legacy fake timers (not planned in v1). `jest.runAllImmediates` always throws the modern timers' TypeError.
- The project's `fakeTimers` config reaches `FakeClockOptions.defaults` (B17c): the worker passes `SerializedProjectConfig.fakeTimers`, which the Jest reader fills from the key less `enableGlobally` (that one is `policy.timers.enableGlobally`). `legacyFakeTimers: true` in it makes the install throw `TIMERS_LEGACY_UNSUPPORTED`, so a project that sets it with `enableGlobally` fails every file by name.
