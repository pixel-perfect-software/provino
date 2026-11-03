# @provino/types

Shared types for Provino: the task tree, the runtime events, the wire protocol, the policy slices, dialects, extension contracts and config. **Types only:** the package has no runtime exports. Functions whose signatures live here (`defineHoistPolicy`, `defineEnvironment`, `environment`, `defineReporter`, `inject`, `createLoader`, `createResolver`) are implemented by the package that owns them and typed with the signature from here, e.g. `export const defineReporter: DefineReporter = (reporter) => reporter`.

| Area | Module | Owner |
| --- | --- | --- |
| Task tree, runtime events, definitions, test context | `src/runtime/` | Track 5 |
| `LazyHost` (what `@provino/lazy` needs from the executor) | `src/runtime/lazy-host.ts` | Track 6 |
| Loader and file registries | `src/loader.ts` | Track 2 |
| Transform records, Jest transformer types | `src/transform.ts` | Track 3 |
| Resolver | `src/resolve.ts` | Track 3 |
| Environments, coverage | `src/environment.ts`, `src/coverage.ts` | Track 8 |
| Pools, wire protocol, scheduler, reporter bus, global setup | `src/orchestrator.ts` | Track 9 |
| Result model, benchmark records | `src/result.ts`, `src/bench.ts` | Track 12 |
| Policy slices, dialects, config, extension contracts, `CloneSafe` | `src/policy/`, `src/dialect.ts`, `src/config.ts`, `src/extensions.ts`, `src/clone-safe.ts` | Track 1 |

## One event model

The research had three event models: Track 5's `RuntimeEvent`, Track 9's `WorkerEvent` (with its own `task:*` and `hook:*` shapes, batched at 100 ms or 64 events) and Track 12's `HarnessEvent`. There is now one (build-plan §6 "Interfaces"):

- **`RuntimeEvent` is the source.** Track 5 owns it, with `TaskId` and `TaskNode`, the one task-tree union. Every event carries `t` (monotonic ms) and refers to tasks by id, so the union is `CloneSafe`.
- **Track 12's fields are part of it,** not a side channel:
  - hook events carry `ownerId`, `ordinal` (the declaration index among the owner's hooks of that kind) and `testId`;
  - `TestTask` carries `fullName` and `dupIndex` (0-based among tests in the file with the same `fullName`, the same rule as the harness's `testKey`);
  - `TaskResult` carries `passingAssertions` and `skipReason`;
  - `console` events carry `taskId` from the current-test lookup, plus `level` and `origin`.
- **`WorkerEvent` is the transport form:** `RuntimeEvent` plus the worker's own `coverage` and `deps` events, sent in batches inside the `pack` message. Batches flush at the end of each macrotask or at 64 events, whichever comes first (§6, built in B09).
- **The reporter bus carries the same events.** Coordinator lifecycle events (`run:start`, `file:queued`, `file:start`, `file:end`, `coverage`, `run:end`, `watch:*`, `error`) carry coordinator data. Every event that starts in the worker is delivered as `[node, event]`: the task (or file) it refers to, and the `RuntimeEvent` itself. Reporters therefore see everything the worker sent, including `test:attempt-start`/`test:attempt-end` and `unhandled`.
- **`HarnessEvent` is derived:** `Extract<RuntimeEvent, …>` in `result.ts`, the events the `normalized-json` reporter turns into a `NormalizedRun`.

Consumers switch over `type` with an exhaustive default, so a new event type fails to compile until every consumer handles it (`test/runtime.test-d.ts`, `test/orchestrator.test-d.ts`).

## Other contracts merged across tracks

- **One resolver:** Track 3's `Resolver` (`resolve(specifier, context): ResolveResult`, `invalidate`, `fingerprint`). Track 2's loader-side resolver types are gone; the loader maps a `ResolveResult` itself.
- **One transform record:** Track 3's `TransformRecord`, which the loader evaluates through `ModuleTransformer`. It gains `hasTopLevelAwait` from Track 2's `TransformedModule`.
- **One source map type,** `SourceMapV3`, and one set of format words, `'esm' | 'cjs'`.
- **`PoolKind`** includes `'inline'` (in-process).
- **Environments** see `RuntimeEvent`s in `onTestEvent` (Jest's `handleTestEvent`).

## `CloneSafe` and plain records

`CloneSafe<T>` rejects an `Error` with extra fields, because `structuredClone` drops them. Types can't tell an `Error` instance from a plain record that also has `name` and `message`, so `SerializedError` declares the phantom member `__record?: never` (never set): `CloneSafe` then checks it field by field. A `JsonValue` passes without being walked.
