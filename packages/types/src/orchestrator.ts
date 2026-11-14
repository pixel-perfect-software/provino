// Track 9 §Types: pools, the wire protocol, the scheduler, the reporter bus and global setup.
// The events on the wire and on the bus are Track 5's `RuntimeEvent`s (one event model, see the
// package README); Track 9's own `task:*`/`hook:*` event shapes are gone. Runtime pieces
// (`defineReporter`, `inject`, the `ExitCode` constant) land in `@provino/orchestrator`.
import type { CloneSafe } from './clone-safe.ts'
import type { SerializedProjectConfig } from './config.ts'
import type { CoverageSummary } from './coverage.ts'
import type { IsolationTier } from './isolation.ts'
import type { PoolKind } from './policy/orchestrator.ts'
import type { SnapshotCounters } from './result.ts'
import type { RuntimeEvent, RuntimeEventOf } from './runtime/events.ts'
import type { FileTask, SerializedError, SuiteTask, TaskId, TestTask } from './runtime/tree.ts'

/**
 * Everything that must match for a warm worker to take the next file.
 * @public
 */
export interface WorkerKey {
  readonly project: string
  readonly pool: PoolKind
  /**
   * The isolation tier the worker is started at: the project's, or the higher one a file's
   * docblock or history asks for (T2.11). A file that needs another tier gets a worker of its own
   * key. `process` is one file per worker: the pool stops the worker once the file is done.
   */
  readonly isolation: IsolationTier
  readonly environment: string
  readonly environmentOptionsHash: string
  readonly execArgvHash: string
  readonly envHash: string
}

/**
 * When a worker is replaced.
 * @public
 */
export interface RecyclePolicy {
  /**
   * RSS (forks) or the isolate's used heap (threads), checked after each file with the
   * `fileDone.memoryBytes` the worker measured: a worker over it is stopped and a new one serves
   * the next file. `0` replaces the worker after every file (Jest's `workerIdleMemoryLimit: 0`).
   * An inline worker is never replaced for memory (what it measures is the coordinator's own).
   * Absent: no check.
   */
  readonly memoryLimitBytes?: number
  /** A worker is replaced after this many files. Absent: never. */
  readonly maxFilesPerWorker?: number
  /**
   * Recycle after a file whose teardown reported leaked handles (Track 2), or globals its
   * environment could not remove (`fileDone.leakedGlobals`, decision D22).
   */
  readonly onLeak?: boolean
}

/**
 * A pool's settings.
 * @public
 */
export interface PoolOptions {
  readonly kind: PoolKind
  /**
   * The most workers alive at once, capped by the transport's own `TransportFactory.maxWorkers`
   * (an `inline` pool runs exactly one, whatever this says).
   */
  readonly maxWorkers: number
  readonly recycle: RecyclePolicy
  /** Then SIGTERM, then SIGKILL after 500 ms. */
  readonly teardownTimeoutMs: number
  readonly startTimeoutMs: number
  /**
   * The longest one file may run. A worker still on a file after this is killed (SIGKILL), and
   * the file fails with `WorkerExit` `{ type: 'timeout', phase: 'file', limitMs }`. Absent: no deadline
   * (a test's own timeout cannot stop a synchronous loop).
   */
  readonly fileTimeoutMs?: number
}

/**
 * How a worker ended.
 * @public
 */
export type WorkerExit =
  | { readonly type: 'signal'; readonly signal: NodeJS.Signals; readonly likelyOom: boolean }
  | { readonly type: 'exit'; readonly code: number }
  | { readonly type: 'oom'; readonly limitMb: number }
  | {
      readonly type: 'timeout'
      readonly phase: 'start' | 'stop' | 'idle' | 'file'
      /** The wait that ran out, in ms: the start timeout, the teardown timeout or `fileTimeoutMs`. */
      readonly limitMs: number
    }

/**
 * Data too big to structured-clone: a JSON string, a temp file, or transferred bytes.
 * @public
 */
export type BulkPayload =
  | { readonly type: 'json'; readonly json: string }
  | { readonly type: 'file'; readonly path: string; readonly bytes: number }
  | { readonly type: 'bytes'; readonly buffer: ArrayBuffer }

/**
 * What a worker is started with.
 * @public
 */
export interface WorkerInit {
  readonly key: WorkerKey
  readonly workerId: number
  readonly isolation: IsolationTier
  /** Values from global setup's `provide()`. */
  readonly provided: Readonly<Partial<ProvidedContext>>
  /** The worker's one project. */
  readonly config: SerializedProjectConfig
  /**
   * An inline worker (a run in band) installs the console capture on `globalThis.console`, so a
   * test's `console` calls reach the reporters as events, as a fork's do. It leaves the process's
   * own stdout and stderr alone: they are the coordinator's, the reporters' included. Forks and
   * threads always capture; omitted, an inline worker captures nothing.
   */
  readonly captureConsole?: true
}

/**
 * One test file to run: the coordinator's work item. (Track 9 calls it `FileTask`; renamed so it
 * doesn't shadow the task tree's `FileTask` node.)
 * @public
 */
export interface FileJob {
  readonly file: string
  readonly fileId: TaskId
  readonly testNamePattern?: string
  /** Only these tests (slow-file splitting, IDE runs). */
  readonly testIds?: readonly TaskId[]
  readonly updateSnapshots: 'all' | 'new' | 'none'
  /**
   * Collect the file and report what its tests would do (`queued`, `skip` or `todo`) without
   * running a hook or a test body (Jest's `--collectTests`); no snapshot is written.
   */
  readonly collectOnly?: true
}

/**
 * An event the worker sends: a runtime event, or one of the worker's own (coverage, the modules
 * a file loaded).
 * @public
 */
export type WorkerEvent =
  | RuntimeEvent
  | {
      readonly type: 'coverage'
      /** The file the data is of, or `null` for a worker's data taken once at the end. */
      readonly fileId: TaskId | null
      readonly payload: BulkPayload
      readonly t: number
    }
  | {
      readonly type: 'deps'
      readonly fileId: TaskId
      /**
       * The user modules the file loaded, as numbers: a worker names each path once for its whole
       * life and sends its id after that, so a file that loads 1,500 modules costs a few
       * kilobytes on the link, not the paths themselves. `ids` has one entry per module, in the
       * worker's order. `added` holds the paths this worker had not sent before; they take the
       * next free ids, in order, from where the worker's earlier `deps` events left off (the
       * first event's `added[0]` is 0). The coordinator keeps one table per worker and rebuilds
       * the list by appending `added` to it, then reading each id.
       */
      readonly added: readonly string[]
      readonly ids: readonly number[]
      readonly t: number
    }

/**
 * Methods the worker calls on the coordinator. Snapshot files are the worker's: it resolves the
 * path and writes the `.snap`, and the coordinator only applies inline edits (build-plan §6), an
 * RPC T7.11 adds.
 * @public
 */
export interface CoordinatorMethods {
  readTimings(file: string): Promise<number | undefined>
}

/**
 * Methods the coordinator calls on a worker.
 * @public
 */
export interface WorkerMethods {
  /**
   * The worker's memory in bytes, measured by the worker itself (a parent can't read a forked
   * child's RSS): RSS in a fork; in a thread or inline, where RSS is the whole process's and
   * `external` counts what the isolate has reserved (a 6 GiB `ArrayBuffer` of oxc-parser's), the
   * isolate's used heap (`v8.getHeapStatistics().used_heap_size`). `fileDone.memoryBytes` uses
   * the same measure.
   */
  memoryUsage(): number
}

/**
 * `Methods` with every method whose arguments or awaited result can't cross a thread replaced by
 * `never`, so `M extends RpcSchema<M>` holds only for a clone-safe interface: a method taking
 * `() => void` fails it.
 * @public
 */
export type RpcSchema<Methods> = {
  readonly [K in keyof Methods]: Methods[K] extends (...args: infer A) => infer R
    ? [A] extends [CloneSafe<A>]
      ? [Awaited<R>] extends [CloneSafe<Awaited<R>>]
        ? Methods[K]
        : never
      : never
    : never
}

/** A method's arguments, as sent. */
type RpcArgs<Method> = Method extends (...args: infer A) => unknown ? Readonly<A> : never

/** Every method's awaited result, as a union. */
type RpcResult<Methods> = {
  [K in keyof Methods]: Methods[K] extends (...args: never) => infer R ? Awaited<R> : never
}[keyof Methods]

/**
 * A call to one of `Methods`, on the wire. `id` pairs it with its reply.
 * @public
 */
export type RpcCall<Methods> = {
  readonly [K in keyof Methods & string]: {
    readonly t: 'call'
    readonly id: number
    readonly method: K
    readonly args: RpcArgs<Methods[K]>
  }
}[keyof Methods & string]

/**
 * The reply to an `RpcCall<Methods>`: the method's result, or the error it threw, serialized.
 * @public
 */
export type RpcReply<Methods> =
  | {
      readonly t: 'reply'
      readonly id: number
      readonly ok: true
      readonly value: RpcResult<Methods>
    }
  | {
      readonly t: 'reply'
      readonly id: number
      readonly ok: false
      readonly error: SerializedError
    }

/**
 * A message from the coordinator to a worker. `start` answers the worker's `ready`; `ack`
 * acknowledges the worker's packs (cumulatively) up to `pack`.
 * @public
 */
export type CoordinatorToWorker =
  | { readonly t: 'start'; readonly init: WorkerInit }
  | { readonly t: 'run'; readonly seq: number; readonly job: FileJob }
  | { readonly t: 'ack'; readonly pack: number }
  | { readonly t: 'cancel'; readonly reason: 'sigint' | 'bail' | 'watch-rerun' }
  | { readonly t: 'stop' }
  | RpcCall<WorkerMethods>
  | RpcReply<CoordinatorMethods>

/**
 * A message from a worker to the coordinator. `ready` says the worker is listening; `pack` is the
 * batched envelope for events; `fileDone` follows the file's last pack.
 * @public
 */
export type WorkerToCoordinator =
  | { readonly t: 'ready' }
  | { readonly t: 'pack'; readonly pack: number; readonly events: readonly WorkerEvent[] }
  | {
      readonly t: 'fileDone'
      readonly seq: number
      readonly memoryBytes: number
      readonly leakedHandles: number
      /**
       * Global keys the file left behind that the environment could not remove (decision D22: a
       * warning, not a failure), as strings (`String(symbol)` for a symbol key). Always present;
       * empty when the file cleaned up. The worker has also sent a `console` warning that names
       * them. Later files in the same worker can see these globals, so the pool recycles a worker
       * whose files leak (`RecyclePolicy.onLeak`, B11). Only a file-scoped teardown reports here: a
       * worker-scoped environment (isolation `none`) reports at `stop`, with the warning alone.
       */
      readonly leakedGlobals: readonly string[]
      /**
       * What the file's snapshot state ended with; absent when the runner kept none or the file
       * never collected its tests. The coordinator adds these up for the summary and the exit
       * code.
       */
      readonly snapshot?: SnapshotFileReport
    }
  | { readonly t: 'stopped' }
  | RpcCall<CoordinatorMethods>
  | RpcReply<WorkerMethods>

/**
 * The caller's view of an RPC interface: every method returns a promise.
 * @public
 */
export type RpcClient<Methods> = {
  readonly [K in keyof Methods]: Methods[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

/**
 * One worker's connection, seen from the coordinator. Forks, threads and in-process workers share
 * one RPC layer over it.
 * @public
 */
export interface Transport {
  readonly kind: PoolKind
  /** The child's pid; `undefined` for a thread or an inline worker. */
  readonly pid: number | undefined
  send(message: CoordinatorToWorker, transfer?: readonly ArrayBuffer[]): void
  /** Returns an unsubscribe function. */
  onMessage(listener: (message: WorkerToCoordinator) => void): () => void
  /** Called once, when the worker has exited. A listener added after that is called at once. */
  onExit(listener: (exit: WorkerExit) => void): () => void
  /**
   * Ends the worker. Graceful: send `stop`, wait the teardown timeout, then SIGTERM, then SIGKILL
   * after 500 ms. `force`: kill at once. Resolves once the worker has exited.
   *
   * `timeout` says the pool is ending the worker because a wait of its own ran out (a file past
   * its deadline): the worker's exit is then `{ type: 'timeout', phase, limitMs }`, whatever signal
   * ended it, unless another timeout was already the reason.
   */
  terminate(
    force: boolean,
    timeout?: { readonly phase: 'file'; readonly limitMs: number },
  ): Promise<void>
}

/**
 * Why a message link closed: the other side exited, disconnected or closed it.
 * @public
 */
export interface LinkClosed {
  readonly type: 'closed'
}

/**
 * One end of an ordered, structured-clone message link (a `MessagePort`, a fork's IPC channel).
 * @public
 */
export interface MessageLink<Out, In> {
  /** `transfer` moves the buffers where the link can (ports); a fork's IPC copies them. */
  send(message: Out, transfer?: readonly ArrayBuffer[]): void
  /** Returns an unsubscribe function. */
  onMessage(listener: (message: In) => void): () => void
  /** Called once, when the link closes. A listener added after that is called at once. */
  onExit(listener: (cause: LinkClosed) => void): () => void
  close(): void
}

/**
 * A worker's side of its transport.
 * @public
 */
export type WorkerPort = MessageLink<WorkerToCoordinator, CoordinatorToWorker>

/**
 * What a worker entry module default-exports. Every transport loads the entry and calls it with
 * the worker's port: in a fork, in a thread, or in the coordinator's own process (inline).
 * @public
 */
export type WorkerMain = (port: WorkerPort) => void | Promise<void>

/**
 * Starts workers of one kind: the pool contract a plugin can contribute.
 * @public
 */
export interface TransportFactory {
  readonly kind: PoolKind
  /**
   * The most workers of this kind that can be alive at once; the pool never starts more, whatever
   * `PoolOptions.maxWorkers` says. Omitted: no limit of its own. The inline transport sets 1
   * (`--runInBand`): the expect slot is process-global, so a second inline worker in the process
   * cannot boot. Two inline runs overlapping in one process share that slot and are not
   * supported; use forks or threads.
   */
  readonly maxWorkers?: number
  /**
   * Whether its workers run in this process (the inline transport). A kill can then only close
   * the worker's link, not end the worker: the pool stops waiting for one once its force signal
   * comes, and gives up on the file it is running. Its memory is the coordinator's own, so a
   * worker is never replaced for holding too much (`RecyclePolicy.memoryLimitBytes`); the file
   * count and a leak still replace it. Omitted: its workers are processes or threads that a kill
   * ends.
   */
  readonly sharesProcess?: boolean
  /**
   * Starts a worker and resolves once it is ready. Aborting `signal` while it starts kills the
   * worker and rejects, so a pool that is closing does not wait for a start.
   */
  create(init: WorkerInit, signal?: AbortSignal): Promise<Transport>
}

/**
 * A file's timing history from the local cache.
 * @public
 */
export interface FileHistory {
  readonly durationMs: number
  readonly failed: boolean
  readonly tests: number
  readonly at: number
  /**
   * A hash of what the file's last passing run read (its module closure, the config, the Node and
   * Provino versions). Room for the per-file result cache (IDEAS I2); nothing writes it yet.
   */
  readonly inputsHash?: string
  /** The tier an earlier run's leak report earned the file (`tierFor`'s `learned`; IDEAS I1). Nothing writes it yet. */
  readonly tier?: IsolationTier
  /**
   * Which functions each test ran, by test id (IDEAS I6, function-level impact). Room for it;
   * nothing writes it yet.
   */
  readonly coverage?: Readonly<Record<string, readonly string[]>>
}

/**
 * A test file as the scheduler sees it.
 * @public
 */
export interface ScheduleInput {
  readonly path: string
  readonly project: string
  readonly sizeBytes: number
  /** From the local cache. */
  readonly history?: FileHistory
  /** From the committed timings file. */
  readonly timingMs?: number
}

/**
 * Orders and shards test files.
 * @public
 */
export interface Sequencer {
  /** Must be pure in (files, shard, timings): the same inputs give the same shard everywhere. */
  shard(
    files: readonly ScheduleInput[],
    shard: { readonly index: number; readonly count: number },
  ): readonly ScheduleInput[]
  sort(files: readonly ScheduleInput[]): readonly ScheduleInput[]
}

/**
 * `provino.timings.json`, the same shape as Bun's `--timings` file.
 * @public
 */
export interface TimingsFile {
  readonly version: 1
  readonly files: Readonly<Record<string, number>>
}

/**
 * A test file, as reporters see it.
 * @beta
 */
export interface FileInfo {
  readonly fileId: TaskId
  /** POSIX, relative to the project root. */
  readonly path: string
  readonly project: string
  /**
   * The project's place among the run's projects (0-based, the config's order). Set by the
   * coordinator, so a reporter can tell two projects of the same name apart and find the project's
   * own config.
   */
  readonly projectIndex?: number
  /**
   * POSIX, relative to the run's root. Set only when that differs from `path`: a run of several
   * projects whose roots differ (Jest's `projects`), where two projects can have a file with the
   * same `path`.
   */
  readonly runPath?: string
}

/**
 * The run being started.
 * @beta
 */
export interface RunInfo {
  readonly root: string
  readonly projects: readonly string[]
  /** Monotonic ms, the same clock as each event's `t`. */
  readonly startTime: number
  readonly watch: boolean
  readonly shard?: { readonly index: number; readonly count: number }
}

/**
 * A file's outcome: from its `file-end` event, or from the worker's exit when the worker died
 * while running it.
 * @public
 */
export interface FileResult {
  readonly file: FileInfo
  readonly state: 'pass' | 'fail' | 'skip'
  readonly durationMs: number
  /** Set when the worker died owning this file. */
  readonly workerExit?: WorkerExit
  readonly errors: readonly SerializedError[]
  /**
   * What the file's snapshot state ended with (the worker's `fileDone.snapshot`); absent when the
   * runner kept none, the file never collected its tests, or it has no result of its own.
   */
  readonly snapshot?: SnapshotFileReport
}

/**
 * Why a run ended: every file passed, a file failed (or `bail` ended the run), the run was
 * interrupted (SIGINT: exit code 130), it was terminated (SIGTERM: 143), or the terminal went away
 * (SIGHUP: 129, `hangup`).
 * @public
 */
export type RunEndReason = 'passed' | 'failed' | 'interrupted' | 'terminated' | 'hangup'

/**
 * What a worker reports about one test file's snapshots when the file ends.
 * @public
 */
export interface SnapshotFileReport {
  /** The file's `.snap`, absolute, or `null` when it has none on disk after the run. */
  readonly file: string | null
  readonly added: number
  readonly matched: number
  readonly unmatched: number
  readonly updated: number
  /** Obsolete snapshots the file didn't check; `0` when its `.snap` was deleted. */
  readonly unchecked: number
  readonly uncheckedKeys: readonly string[]
  /** The `.snap` file was deleted: it held no snapshot after the run. */
  readonly fileDeleted: boolean
}

/**
 * A run's snapshots: Jest's aggregate (`SnapshotCounters`), the keys that were obsolete in each
 * file, and the update mode the run used.
 * @public
 */
export interface SnapshotRunSummary {
  readonly counters: SnapshotCounters
  readonly uncheckedKeysByFile: readonly {
    readonly file: string
    readonly keys: readonly string[]
  }[]
  /** `all` rewrites snapshots (`-u`), `new` writes only new ones, `none` writes nothing (CI). */
  readonly update: 'all' | 'new' | 'none'
  /** Every `.snap` file a file of the run left on disk, absolute. */
  readonly files: readonly string[]
}

/**
 * A resource that was still open, and keeping the process from exiting, after the run's last file
 * (`detectOpenHandles`): what kind it is and the stack that created it.
 * @public
 */
export interface OpenHandle {
  /** What kind of resource: `Timeout`, `Immediate`, `TCPSERVERWRAP`... (the async resource's type). */
  readonly type: string
  /**
   * The creating stack, innermost frame first, as `at ...` lines: the frames of the user's code
   * (Node's own and Provino's are left out).
   */
  readonly frames: readonly string[]
  /** A few lines of source around the innermost frame, with a caret under the column; absent if it can't be read. */
  readonly codeFrame?: string
}

/**
 * A finished run.
 * @public
 */
export interface RunSummary {
  readonly reason: RunEndReason
  readonly files: readonly FileResult[]
  readonly unhandled: readonly SerializedError[]
  readonly durationMs: number
  /** The run's snapshots, when any file reported some. */
  readonly snapshots?: SnapshotRunSummary
  /**
   * Whether a project's own snapshot rule fails the run (obsolete snapshots under its policy and
   * update mode), when the coordinator judged it: a run over projects with different rules is
   * judged project by project, and `snapshots` is the merge, for display. Absent, a reader judges
   * `snapshots` by one policy.
   */
  readonly snapshotsFail?: boolean
  /** What `detectOpenHandles` found still open after the last file; absent when it was off or found none. */
  readonly openHandles?: readonly OpenHandle[]
}

/**
 * The reporter bus's events and their arguments. The coordinator's own lifecycle events carry
 * coordinator data. Every event that starts in the worker carries the task it refers to (or the
 * file) and the `RuntimeEvent` itself, so reporters see the whole event model, nothing less.
 * @public
 */
export interface ReporterEvents {
  'run:start': [info: RunInfo, files: readonly FileInfo[]]
  'file:queued': [file: FileInfo]
  /**
   * A worker took the file. Every `file:start` is followed by exactly one `file:end`, and a
   * `file:end` never comes without its `file:start`, with one exception: a run that ends by `bail`
   * kills the files still running and, as Jest does, reports them no further (they get no
   * `file:end` and are not in the summary). A file whose worker failed to start gets
   * `file:start` just before its `file:end`, with the id of the worker whose failed start its
   * error is (for the files left when the pool gave up, the last one). A file that was never
   * started (the run was aborted before) gets neither event.
   */
  'file:start': [file: FileInfo, workerId: number]
  'file:collected': [file: FileInfo, event: RuntimeEventOf<'file-collect-end'>]
  'task:start': [task: SuiteTask | TestTask, event: RuntimeEventOf<'suite-start' | 'test-start'>]
  'test:attempt-start': [test: TestTask, event: RuntimeEventOf<'test-attempt-start'>]
  'test:attempt-end': [test: TestTask, event: RuntimeEventOf<'test-attempt-end'>]
  'task:end': [task: SuiteTask | TestTask, event: RuntimeEventOf<'suite-end' | 'test-end'>]
  'hook:start': [owner: FileTask | SuiteTask, event: RuntimeEventOf<'hook-start'>]
  'hook:end': [owner: FileTask | SuiteTask, event: RuntimeEventOf<'hook-end'>]
  annotation: [test: TestTask, event: RuntimeEventOf<'annotation'>]
  console: [file: FileInfo, event: RuntimeEventOf<'console'>]
  /** An unhandled error in a worker; `file` is `null` when it can't be tied to one. */
  unhandled: [file: FileInfo | null, event: RuntimeEventOf<'unhandled-error'>]
  /**
   * The file's result, always after its `file:start` and the last of its own events. A file cut
   * off by an abort that had started ends here as a `fail` with an error naming the interruption.
   */
  'file:end': [result: FileResult]
  coverage: [summary: CoverageSummary]
  'run:end': [summary: RunSummary]
  'watch:waiting': []
  'watch:rerun': [changed: readonly string[], trigger: 'change' | 'key' | 'restart']
  /** An error outside any test file. */
  error: [error: SerializedError, origin: 'coordinator' | 'reporter' | 'globalSetup']
}

/**
 * A reporter's handlers, one optional handler per bus event.
 * @public
 */
export type ReporterHandlers = {
  readonly [K in keyof ReporterEvents]?: (...args: ReporterEvents[K]) => void | Promise<void>
}

/**
 * A reporter.
 * @public
 */
export interface Reporter extends ReporterHandlers {
  readonly name: string
  /** A reporter failure that must fail the run (Jest's `getLastError`). */
  readonly lastError?: () => SerializedError | undefined
}

/**
 * The signature of `defineReporter`. Only `name` is generic, so an object literal keeps its
 * excess-property check on event names.
 * @public
 */
export type DefineReporter = <const N extends string>(
  reporter: Reporter & { readonly name: N },
) => Reporter & { readonly name: N }

/**
 * Delivers events to reporters.
 * @public
 */
export interface ReporterBus {
  emit<K extends keyof ReporterEvents>(event: K, ...args: ReporterEvents[K]): Promise<void>
  add(reporter: Reporter): void
}

/**
 * Values global setup provides to tests. Augmented by users:
 * `declare module '@provino/types' { interface ProvidedContext { dbUrl: string } }`.
 * @public
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by users (declaration merging).
export interface ProvidedContext {}

/**
 * What a global setup function receives.
 * @public
 */
export interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]): void
  onTestsRerun(callback: () => void | Promise<void>): void
  readonly project: { readonly name: string; readonly root: string }
}

/**
 * A global setup function; it may return a teardown.
 * @public
 */
export type GlobalSetupFn = (
  context: GlobalSetupContext,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>

/**
 * The signature of the worker-side `inject`: reads a value global setup provided.
 * @public
 */
export type Inject = <K extends keyof ProvidedContext>(key: K) => ProvidedContext[K]
