# @provino/orchestrator

The coordinator (`.`) and the worker entry (`./worker`), as two manifest nodes in one package. They never import each other: shared types come from `@provino/types` and shared runtime code from `@provino/rpc`. B09 built the transports, the per-worker connection and the worker-side packer. B10 built the worker runtime (U1): `./worker/main`, the entry that wires the loader, the environment, the dialect's globals, `@provino/expect` and `@provino/core` behind `startWorker`. The pool, scheduler and reporters come later (see "Not built yet").

## Module map

| File | Node | What it does |
|---|---|---|
| `src/transport/shared.ts` | coordinator | `createTransport(kind, options, spawn)`, the one scaffold, and `connect()`: the `ready` → `start` handshake, the start timeout, one exit report, and `terminate` (`stop` → teardown timeout → SIGTERM → 500 ms → SIGKILL) |
| `src/transport/forks.ts`, `threads.ts`, `inline.ts` | coordinator | Each kind's `spawn`: starting one worker and mapping how it ends to a `WorkerExit` |
| `src/connect.ts` | coordinator | `connectWorker`: serves `CoordinatorMethods`, hands packs to `onEvents` in order, acks after it settles, and resolves `run()` on `fileDone` |
| `src/worker/start.ts` | worker | `startWorker(port, runner)`: the worker side of the protocol; the runner is `createRuntimeRunner()` in the real worker |
| `src/worker/main.ts` | worker | The real entry (`./worker/main`): `startWorker(port, createRuntimeRunner(), { serializeError: core's, console: { currentTaskId } })`. `currentTaskId` reads core's `currentTest`: the test, else the suite or file whose hook runs |
| `src/worker/runtime/runner.ts` | worker | `createRuntimeRunner()`: `start`, `runFile` and `stop` of the runtime (see below) |
| `src/worker/internal/runtime/config.ts` | worker | `parseProjectConfig` (`@internal`): checks `init.config` (it crossed a link) and throws `ORCH_BAD_CONFIG` naming the key. `environment.module` and `globals.module` must be an absolute path or URL, and each `loader.mappers[i]` a `{ factory: ModuleRef, options }` |
| `src/worker/internal/runtime/environment.ts` | worker | Importing the environment by ref, validating it and its instance, `prepare` once, `setup` per use (`ORCH_BAD_ENVIRONMENT`) |
| `src/worker/internal/runtime/globals.ts`, `sink.ts` | worker | `installGlobals` (configurable, writable data properties); `assertionCountSink` (fills `assertions` and `passingAssertions` on `test-end` from the last attempt's expect state) |
| `src/worker/errors.ts` | worker | `WorkerError` and `WorkerErrorCode` (`ORCH_BAD_CONFIG`, `ORCH_BAD_ENVIRONMENT`, `ORCH_BAD_GLOBALS`, `ORCH_NOT_STARTED`, `ORCH_NO_ACTIVE_FILE`): the worker node cannot import the coordinator's `OrchestratorError`, so it has its own class in the same `ORCH_` namespace |
| `src/worker/packer.ts` | worker | Packs: 64 events or the end of the macrotask, numbered, cumulative acks, at most 8 in flight; `afterSent` orders `fileDone`/`stopped` behind them |
| `src/worker/console.ts` | worker | Console capture: a stable front over a replaceable `Console`, plus patched stream `write`s |
| `src/worker/stdio.ts`, `timers.ts` | worker | The stdio flush (only when bytes are buffered), and timers taken at load |
| `src/worker/bootstrap.ts` | worker | The fork and thread main. Never imported; the coordinator finds it with `import.meta.resolve('@provino/orchestrator/worker/bootstrap')` |

## How a worker runs

1. The transport spawns `bootstrap.ts` and passes the entry module URL: `argv[2]` for a fork, `workerData.entry` for a thread. Inline has no bootstrap: the transport imports the entry itself and builds the port over a `MessageChannel`.
2. The entry's default export (`WorkerMain`; `./worker/main` for the real worker) gets a `WorkerPort` and calls `startWorker`. That sends `ready`; the transport answers with `start` and only then resolves `create()`. The `start` send is the one check that the init can cross: a value the link can't write kills the worker and rejects with `ORCH_BAD_INIT`.
3. Each `run` gets a fresh console, goes through `runner.runFile`, then yields one macrotask (every microtask the file left behind runs, so a floating `.then` that logs is still in the file's output), flushes stdio, and queues `fileDone` with `packer.afterSent`. Every event emitted before that call precedes `fileDone`, by construction. A runner that throws (in `runFile`, or in `start`, which then fails every file) is charged to the file as an `unhandled-error`, and the file still gets its `fileDone`: no failure can stall the worker's queue. A `cancel` aborts the running file and every file already queued.
4. `stop` drains the queue, calls `runner.stop` (when `start` came; a throw is charged as an `unhandled-error` with no owner, and `stopped` is sent anyway), sends `stopped` and closes the link. The bootstrap then **exits on purpose** (`process.exit(0)`), after a fork's IPC disconnect, so a handle a test leaked can't keep the worker alive. If the coordinator dies, the link closes and the worker exits the same way.

## The runtime (`createRuntimeRunner`)

The environment and the dialect's globals load **by ref** (`config.environment`, `config.globals`), never by import: this node knows no dialect and no environment package.

- **`start`, once.** Parse the config → one behaviour loader and one project loader (`createProjectLoader`) → expect in its documented boot order (state source, matcher registry, slot, the dialect's table, `createExpect`, then `snapshotRegistry(registry, expect)`) → `createRuntime` with the assertion-count sink in front of the packer → the environment's `prepare` once → the globals factory once, if `policy.core.injectGlobals`. A throw here fails every file with its code (`startWorker`'s `startFailure`).
- **`runFile`, per job.** Wait for the packer's `writable()` (a cancelled file never starts) → `loader.createFileRegistry(file, { tier })` (`process` runs as `registry`; `realm` throws `LOADER_NOT_IMPLEMENTED` here, before anything is set up) → environment `setup` (scope `file`, with the file's `signal`; scope `worker` under `none`, set up once for the first file, with `testPath` that file's path and a worker-lifetime `signal` the runner aborts in `stop`) → install the globals on `instance.global`, every file → `source.startFile` → `runtime.runFile(file, { testNamePattern, testIds })`, whose `importFile` imports each of `setupFiles` and then `setupFilesAfterEnv` and then the test file, inside collection (under `none` each of them, the test file included, is `invalidate`d first; the other tiers have a new registry, so they skip the extra resolver call) → teardown.
- **Teardown order**, always, each step running whatever the earlier ones threw: the environment's `teardown` (file scope), the matcher restore (file scope), `registry.dispose()`. What threw is rethrown after all three (an `AggregateError` for several), and `startWorker` charges it to the file as an `unhandled-error` and still sends `fileDone`. `ENV_NODE_RESTORE_FAILED` arrives this way.
- **`stop`.** `runtime.dispose()`, the worker-scoped environment's `teardown`, `loader[Symbol.dispose]()`, `slot.uninstall()`, then the worker-lifetime signal is aborted; errors collected and rethrown after all of them. It copes with a worker whose `start` threw half-way, and runs twice without harm.

## Rules that aren't obvious

- **Globals come in before `setupFiles`**, as the brief and Track 11 (T11.10) say. Real Jest installs `describe`/`expect` after `setupFiles`; B14 records a fixture and decides (a policy key, or a DIVERGENCES entry).
- **Setup files are fresh for every file, in every tier, and so is the test file.** Under `none` the registry is shared, so the setup module and the test file itself (queued twice, or imported by an earlier file) are invalidated and imported again (their dependencies stay shared); `isolateModules` would re-instantiate those too. They run inside collection, so a hook they register belongs to the file, and a throwing one fails the file with no tests.
- **Back-pressure is per file, not per test:** a file waits for `sink.writable()` before it starts, which bounds the worker's buffer to about one file's events beyond the 8-pack window. A per-test wait would need an async hook in core's executor (T5.8).
- **A config ref that crosses is absolute.** `environment.module` and `globals.module` are an absolute path or URL (`file:` from `import.meta.resolve`); a bare package specifier is `ORCH_BAD_CONFIG`, because the worker would resolve it from this package, not the project. B11's coordinator resolves them.
- **`none` keeps everything:** the environment, the globals, the custom matchers (`snapshot.restore()` is file scope only, as in Vitest's `isolate: false`) and the registry. They go at `stop`.
- **`FileJob.fileId` is core's id** (SHA-1 over `<project>\0<relative path>`, 10 hex characters). Core does not export it; B11's coordinator will need its own. The bench and `test/support.ts` repeat the formula, and every event's id is checked against it.
- **A fork's exit is reported after `exit` *and* the IPC `disconnect`.** `exit` can arrive before the child's last messages are read, so closing the link on `exit` would drop them. A 1 s fallback covers a grandchild that holds the channel open. That's also why `childProcessLink` closes on `disconnect`, not `exit`.
- **A child's `processLink.close()` waits for queued writes** before it disconnects, because a disconnect cancels pending IPC writes, `stopped` included.
- **Links queue while nobody listens** and hand the queue, in order, to the next listener. The handshake listener unsubscribes on `ready`, and nothing after it is lost.
- **A timeout overrides the raw exit.** A worker killed after the start or teardown timeout reports `{ type: 'timeout', phase }`, not the signal used to kill it.
- **Inline workers don't patch globals.** Console capture installs on `globalThis.console` and `process.stdout`/`stderr` only when `init.key.pool !== 'inline'`: an inline worker shares the coordinator's stdio, and `node:test` reports over it. Inline runners use `context.console`; tests pass stand-in streams. The real runtime hands `context.console` to the environment's `setup` but does not install it itself, so a test's `console` in an inline worker prints to the coordinator's stdout (forks and threads capture it through the patched global).
- **The worker takes its timers at load** (`worker/timers.ts`), so fake timers installed by a test file can't stall a flush or the end-of-file yield.
- **Stdio is flushed only when bytes are buffered** (`writableLength > 0`). With capture installed nothing reaches the real stream, and in a thread an empty write's callback waits on the coordinator's event loop.
- **A pack that won't send never throws.** It goes again with each unclonable event replaced by an `unhandled-error`; the window and pack numbers stay intact.
- **No coalescing.** Every `RuntimeEvent` is a transition reporters see (§6's one event model). The brief's "coalesce per task" came from Track 9's retired `task:update` shape (DECISIONS P4).
- **`WorkerMethods.memoryUsage` replaces `Transport.memoryUsage`.** A parent can't read a forked child's RSS, so the worker measures itself: RSS in a fork, `heapUsed + external` in a thread or inline.

## Tests

- `src/**/*.test.ts`: unit tests per node: the packer, console capture, `startWorker` over a raw `MessageChannel` (the test plays the coordinator), `connect()`'s handshake races over a fake spawned worker, and `connectWorker` over a fake transport.
- `test/**/*.test.ts`: end to end over real forks, threads and inline workers. Fixtures in `test/fixtures/` are worker entries (`WorkerMain` default exports), plus a seeded PRNG and the console-order program generator. Tests here may import both entries (the `<package>/test` manifest node).
  - `transport.test.ts`: 1,000 round trips per kind, stop, kill, both timeouts, SIGKILL escalation, stdio piping.
  - `isolation.test.ts`: spike A2's table. The threads SIGSEGV case runs a whole coordinator in a child process, which must die by SIGSEGV.
  - `rpc-exit.test.ts`, `events.test.ts` (10k events, window ≤ 8), `console-order.test.ts` (the property; replay one seed with `PROVINO_SEED`), `runner-errors.test.ts` (runner failures, and late output on forks and threads).
  - `runtime.test.ts` (inline, the real entry): setup order, setup files per file in both tiers, the per-file filters, assertion counts, teardown order and a throwing teardown, `stop`, bad configs and environments, `realm`, and file A's leaks under `registry` and `none`. `runtime-runner.test.ts` drives `createRuntimeRunner()` directly (back-pressure, cancel, out-of-order use). `runtime-transports.test.ts` runs the real entry over each transport (errors keep their `code`, console is tied to the test).
  - The fixtures `runtime-env.ts`, `runtime-globals.ts`, `runtime-table.ts` and `runtime-mapper.ts` stand in for what a project supplies by ref (the orchestrator may not depend on a dialect or an environment package). They write to `globalThis.__trace` when a test sets one (and the environment keeps each `setup` signal in `globalThis.__signals`), which an inline worker shares. Test files are generated into `$TMPDIR` as `.js` text. The Jest dialect with the real node environment runs in `@provino/bench` (`pnpm bench:worker check`, `packages/bench/src/worker/worker.test.ts`).
- `src/worker/internal/runtime/*.test.ts`: the pure pieces (`config`, `environment`, `globals`, `sink`), which are `@internal` and sit beside their source.
- `test/support.ts` holds the shared pieces (`initFor`, `job`, `methods`, `forceKilled`, `Collect`, `factoryFor`, and for the runtime `makeProject`, `runtimeConfig`, `runJobs`, `fileIdOf`); the `src/` tests keep their own, since they sit in the coordinator and worker nodes.
- Workers print crash output (the OOM case's V8 fatal error). Pass a `Collect` stream as `stderr` to keep it out of the test output.

## Not built yet

| What | Owner |
|---|---|
| Pool: `WorkerKey` reuse, recycling, lazy spawn, crash → file failed → replacement | T9.5 (B11 minimal, B21) |
| `cancel` reaching core (a cancelled file stops mid-run): today it only keeps a queued file from starting | T5.12 |
| The environment's `onTestEvent` (Jest `handleTestEvent`) | T11/T8 |
| Docblock pragmas (`pragmas` is `{}` in the environment's setup context), `@provino-isolate` escalation | T2.11 |
| Leak count (`FileOutcome.leakedHandles` is always 0) | T2.7 |
| The `realm` tier (and an environment with realm `context`) | T2.8 |
| `BulkPayload` for coverage and snapshots over 64 KiB | Track 8, T7.10 |
| `inject`/`provide` backing store | T9.9 (B21) |
| Jest's console `origin` (the call site) | B14 |
| Reading config files and building the `SerializedProjectConfig`; spawning workers | B11 |
| Scheduler, reporters, watch, global setup, exit codes | T9.6–T9.13 |
