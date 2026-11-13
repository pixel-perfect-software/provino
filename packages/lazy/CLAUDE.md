# @provino/lazy

RSpec-style lazy variables (Track 6). Neutral: it reads only `LazyPolicy` and a `LazyHost` (`@provino/types`), never imports core or a dialect, and compares nothing against a dialect name. Tests reach it by import (`import { lazy } from 'provino'`), never as a global.

## Map

| Module | Role |
|---|---|
| `src/types.ts` | The public types (B24a). Type tests in `test/`: `lazy.test-d.ts`, `type-errors.test.ts` (each `@ts-expect-error` carries its code and a message substring), `typeperf.test.ts` (60 chained `.let`s under 150k instantiations) |
| `src/errors.ts`, `src/slot.ts`, `src/api.ts` | `LazyError` (branded, `instanceof` holds across module copies), the `Symbol.for('provino.lazy.runtime')` slot, and the frozen forwarders that read it when called (`LAZY_NO_RUNTIME` with none) |
| `src/runtime/create.ts` | `createLazyRuntime({ host, policy, describe })`: the root handle, `evaluatedLazies` and the shared-example functions (the whole `LazyRuntime`); `describe` is the worker's, which `itBehavesLike` opens a nested suite with |
| `src/runtime/state.ts` | `LazyEntry` (shaped as `@provino/types` `Definition`; `define` is B25's `factory`), `Cell` (a memo: value, error, in flight, eager wait), the private slots symbols, `Engine` |
| `src/runtime/table.ts` | The interim definition table (each suite's `slots`, one entry per key), `register` (reserved key, scope placement, duplicates), `resolveEntry` (innermost suite outward, cached per suite), `settle` (parent entry, scope, eagerness and memo key, fixed on first read) and the `onCollected` check that every override has a definition around it |
| `src/runtime/read.ts` | `readFrom` (the hot path), `run` (one evaluation: deps view, context, sync stack, timeout, log), the deps view (a class per suite with prototype getters), `evaluateEager`, `peek` for `inspect` |
| `src/runtime/handle.ts` | The frozen handle: enumerable getter per key (shared descriptors), non-enumerable `let`/`eager`/`override`/`from`, `toJSON`, `Symbol.toStringTag`, `util.inspect.custom` |
| `src/runtime/shared.ts` | `sharedExamples`/`sharedContext` brand a frozen `{ name }` with the body under `Symbol.for('provino.lazy.shared.body')` (so a group made by another copy runs). `itBehavesLike` opens `describe('behaves like <name>')` and runs the body there; `includeExamples` and `includeContext` run it in the suite being collected (`LAZY_NOT_COLLECTING` otherwise, `LAZY_INVALID` for a non-group). The body's `$` is a fresh handle with the caller's keys, so reads resolve from the running test's suite and see the caller's overrides |
| `src/runtime/eager.ts`, `cleanup.ts`, `site.ts` | The eager hook; `onCleanup` lists (test: `run.addTeardown`; file: one `file.teardowns` entry; worker: one worker teardown plus its own `AbortController`); the definition site from `Error.captureStackTrace` |
| `src/internal/test-support.ts` | A fake `LazyHost` (collector, runner, ALS frame per run) for this package's tests |

## Rules the runtime keeps

- **Resolution** is by the running test's innermost suite, never the suite that declared the handle. `parent()` resolves from the declaring suite's parent and is not memoized (once per evaluation). One entry per key per suite: a second one in the same suite, `.override` included, is `LAZY_DUPLICATE`.
- **Memo** lives in the scope's map: test `run.slots`, file `file.slots`, worker `host.workerSlots` (keyed by `Symbol.for('provino.lazy.worker:<file:line:col#key>')`, so two files with one helper share a value). Async values memoize the promise; a throw or rejection is memoized too. A `Cell` in state `EVAL` seen by a read is always a synchronous re-entry, so it is a cycle (`LAZY_CYCLE`, from the sync stack); a cycle through `deps` after an `await` is found by the chain each evaluation carries. A cycle through `$` after an `await` waits for the test timeout (documented gap 3).
- **Scope** is checked on every read made while a definition runs (`deps` reads and `$` reads under the sync stack): a wider-scoped definition reading a narrower one is `LAZY_SCOPE` with both sites. A test-scoped read in a suite hook follows `readInBeforeAll`: `error` is `LAZY_SCOPE`; `allow` (Provino's own, tests not ground truth) memoizes per suite in `suite.slots`, cleans up with the file, and gives `ctx.task` a task named for the suite.
- **Eager** evaluates what the test sees (`resolveEntry` in the hook), awaits it and replaces the memo; a read before then is `LAZY_EAGER_PENDING`. An override of an eager key stays eager (a file or worker one gets its own `beforeAll` where it is declared); a hook evaluates only the entry that registered it or its overrides, so a nested re-declare runs at its own position; a nested `lazy.let` of it makes it lazy again, as its type says (`Exclude<E, K>`).
- **The log** (`evaluatedLazies(run)`) holds one entry per finished evaluation of a test run, dependencies before dependents, `ms` inclusive of dependencies. File and worker values evaluated from a test land in that test's log.
- **Timeout** (`LetOptions.timeout`) only bounds a definition that returns a thenable; timers are the real ones, captured at module load.

## The core check

`packages/bench/src/lazy/` (`pnpm bench:lazy check`) runs 35 behaviours under the Jest dialect's whole policy and the neutral one on the real `createRuntime`, 70 checks, 0 failed (T6.5). `behaviours.ts` is the rebuilt Spikes C corpus. It found no `LazyHost` gap in core. Never lower the count.

## Where it is wired (B24d)

The worker (`packages/orchestrator/src/worker/runtime/runner.ts`) installs it after core and before the environment, and `stop` uninstalls it; `provino` re-exports the forwarders. `packages/provino/test/lazy.test.ts` runs it end to end on the built package. User docs: `wiki/lazy-variables.md`.

## Not built yet

`LazyEvaluation` in `@provino/types`, `LAZY_CHAIN` on thrown values and the reporter block (B24e); the read-cost gate (B24f); `fixtures.compile` (T6.9). B25's T5.9 moves the table into core behind a `LazyHost` method.
