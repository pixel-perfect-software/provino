# @provino/orchestrator

The coordinator (`.`) and the worker entry (`./worker`), as two manifest nodes in one package. They never import each other: shared types come from `@provino/types` and shared runtime code from `@provino/rpc`. B09 built the transports, the per-worker connection and the worker-side packer. The pool, scheduler, reporters and the real worker runtime come later (see "Not built yet").

## Module map

| File | Node | What it does |
|---|---|---|
| `src/transport/shared.ts` | coordinator | `createTransport(kind, options, spawn)`, the one scaffold, and `connect()`: the `ready` → `start` handshake, the start timeout, one exit report, and `terminate` (`stop` → teardown timeout → SIGTERM → 500 ms → SIGKILL) |
| `src/transport/forks.ts`, `threads.ts`, `inline.ts` | coordinator | Each kind's `spawn`: starting one worker and mapping how it ends to a `WorkerExit` |
| `src/connect.ts` | coordinator | `connectWorker`: serves `CoordinatorMethods`, hands packs to `onEvents` in order, acks after it settles, and resolves `run()` on `fileDone` |
| `src/worker/start.ts` | worker | `startWorker(port, runner)`: the worker side of the protocol, run by B10's runtime |
| `src/worker/packer.ts` | worker | Packs: 64 events or the end of the macrotask, numbered, cumulative acks, at most 8 in flight; `afterSent` orders `fileDone`/`stopped` behind them |
| `src/worker/console.ts` | worker | Console capture: a stable front over a replaceable `Console`, plus patched stream `write`s |
| `src/worker/stdio.ts`, `timers.ts` | worker | The stdio flush (only when bytes are buffered), and timers taken at load |
| `src/worker/bootstrap.ts` | worker | The fork and thread main. Never imported; the coordinator finds it with `import.meta.resolve('@provino/orchestrator/worker/bootstrap')` |

## How a worker runs

1. The transport spawns `bootstrap.ts` and passes the entry module URL: `argv[2]` for a fork, `workerData.entry` for a thread. Inline has no bootstrap: the transport imports the entry itself and builds the port over a `MessageChannel`.
2. The entry's default export (`WorkerMain`) gets a `WorkerPort` and calls `startWorker`. That sends `ready`; the transport answers with `start` and only then resolves `create()`. The `start` send is the one check that the init can cross: a value the link can't write kills the worker and rejects with `ORCH_BAD_INIT`.
3. Each `run` gets a fresh console, goes through `runner.runFile`, then yields one macrotask (every microtask the file left behind runs, so a floating `.then` that logs is still in the file's output), flushes stdio, and queues `fileDone` with `packer.afterSent`. Every event emitted before that call precedes `fileDone`, by construction. A runner that throws (in `runFile`, or in `start`, which then fails every file) is charged to the file as an `unhandled-error`, and the file still gets its `fileDone`: no failure can stall the worker's queue. A `cancel` aborts the running file and every file already queued.
4. `stop` drains, sends `stopped` and closes the link. The bootstrap then **exits on purpose** (`process.exit(0)`), after a fork's IPC disconnect, so a handle a test leaked can't keep the worker alive. If the coordinator dies, the link closes and the worker exits the same way.

## Rules that aren't obvious

- **A fork's exit is reported after `exit` *and* the IPC `disconnect`.** `exit` can arrive before the child's last messages are read, so closing the link on `exit` would drop them. A 1 s fallback covers a grandchild that holds the channel open. That's also why `childProcessLink` closes on `disconnect`, not `exit`.
- **A child's `processLink.close()` waits for queued writes** before it disconnects, because a disconnect cancels pending IPC writes, `stopped` included.
- **Links queue while nobody listens** and hand the queue, in order, to the next listener. The handshake listener unsubscribes on `ready`, and nothing after it is lost.
- **A timeout overrides the raw exit.** A worker killed after the start or teardown timeout reports `{ type: 'timeout', phase }`, not the signal used to kill it.
- **Inline workers don't patch globals.** Console capture installs on `globalThis.console` and `process.stdout`/`stderr` only when `init.key.pool !== 'inline'`: an inline worker shares the coordinator's stdio, and `node:test` reports over it. Inline runners use `context.console`; tests pass stand-in streams.
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
- `test/support.ts` holds the shared pieces (`initFor`, `job`, `methods`, `forceKilled`, `Collect`, `factoryFor`); the `src/` tests keep their own, since they sit in the coordinator and worker nodes.
- Workers print crash output (the OOM case's V8 fatal error). Pass a `Collect` stream as `stderr` to keep it out of the test output.

## Not built yet

| What | Owner |
|---|---|
| Pool: `WorkerKey` reuse, recycling, lazy spawn, crash → file failed → replacement | T9.5 (B11 minimal, B21) |
| The real runner behind `startWorker` (loader → core → expect), `passingAssertions`, the current-test lookup for console attribution | U1 (B10) |
| `BulkPayload` for coverage and snapshots over 64 KiB | Track 8, T7.10 |
| `inject`/`provide` backing store; `WorkerInit` contents (policy, dialect runtime ref) | T9.9 (B21); U1 (B10) |
| Jest's console `origin` (the call site) | B10/B14 |
| Scheduler, reporters, watch, global setup, exit codes | T9.6–T9.13 |
