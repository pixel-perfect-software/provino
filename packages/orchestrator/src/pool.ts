// T9.5 (Track 9 §Pool): lazy spawn up to `maxWorkers`, warm reuse by `WorkerKey`, one file in
// flight per worker, a crash charged to the one file that was running, and a worker replaced
// after a file that leaked globals (D22), after `maxFilesPerWorker` files, or once it holds more
// than `memoryLimitBytes`. A file still running after `fileTimeoutMs` has its worker killed. A
// run that bails closes the pool; a second Ctrl+C is its `forceSignal`.
import { availableParallelism } from 'node:os'
import type { RpcHandlers } from '@provino/rpc'
import type {
  CoordinatorMethods,
  FileJob,
  PoolKind,
  PoolOptions,
  Transport,
  TransportFactory,
  WorkerEvent,
  WorkerExit,
  WorkerInit,
  WorkerKey,
} from '@provino/types'
import { connectWorker, type FileDone, type WorkerConnection } from './connect.ts'
import { OrchestratorError } from './errors.ts'
import { sameWorkerKey, workerKeyId } from './key.ts'
import { describeExit } from './transport/shared.ts'

/** After this many workers in a row fail to start, the pool starts no more (Track 9). */
const MAX_START_FAILURES = 3

/**
 * The default `maxWorkers`: every core but one, and at least one (Track 9 §Pool 4).
 * @public
 */
export function defaultMaxWorkers(): number {
  return Math.max(1, availableParallelism() - 1)
}

/**
 * What an error the pool reports is: a worker lost while it ran no file, or anything else.
 * @public
 */
export type PoolErrorKind = 'worker-lost' | 'other'

/**
 * What a pool needs from the run that owns it.
 * @public
 */
export interface PoolDeps {
  /** Makes the transport factory for `PoolOptions.kind`. Called once. */
  readonly transport: (kind: PoolKind) => TransportFactory
  /** The init a new worker of `key` is started with. */
  readonly init: (key: WorkerKey, workerId: number) => WorkerInit
  /** The coordinator methods every worker may call. */
  readonly methods: RpcHandlers<CoordinatorMethods>
  /**
   * Receives the events of a worker that is running no file: what it sends while it stops (the
   * teardown of a worker-scoped environment). Without it they are dropped.
   */
  readonly onIdleEvents?: (workerId: number, events: readonly WorkerEvent[]) => void | Promise<void>
  /**
   * Receives a failure of `onIdleEvents`, or of a `FileRequest.onEvents` that fails after its file
   * is over, and a worker that ended badly while it ran no file (`kind` `'worker-lost'`, the error
   * `ORCH_WORKER_EXITED`; anything else is `'other'`). Without it the error is thrown, uncaught.
   */
  readonly onError?: (error: unknown, kind: PoolErrorKind) => void
  /** Aborting it behaves like `close`, and files that were running or waiting are `aborted`. */
  readonly signal?: AbortSignal
  /**
   * Aborting it kills every worker that is still alive at once (SIGKILL), the ones in the middle
   * of a graceful stop included, so `close` returns without waiting out the teardown timeout. It
   * also aborts the pool, as `signal` does: a second Ctrl+C is this.
   *
   * An inline worker is this process, so a kill can only close its link: a file that is awaiting
   * something is given up on (its `run` is `aborted`, and `close` does not wait for the worker to
   * wind down), but code that is looping synchronously in-process cannot be interrupted at all.
   */
  readonly forceSignal?: AbortSignal
}

/**
 * One file for the pool to run.
 * @public
 */
export interface FileRequest {
  /** What the worker must match to take the file. */
  readonly key: WorkerKey
  readonly job: FileJob
  /** Called once a worker has taken the file, before the job is sent to it. */
  readonly onStart?: (workerId: number) => void | Promise<void>
  /** Receives each pack of the file's events, in order; the worker waits for it to settle. */
  readonly onEvents: (events: readonly WorkerEvent[]) => void | Promise<void>
  /**
   * Called when the worker has finished the file, with every one of its events handled, and
   * before the pool gives that worker (or its replacement) the next file: a decision that must
   * come before the next file starts (`--bail`) is made here. It must not throw; if it does, the
   * error goes to `PoolDeps.onError` and the file is `done` all the same.
   */
  readonly onDone?: (done: FileDone) => void
}

/**
 * How a file ended in the pool.
 * - `done`: the worker finished the file (it may have failed; its events say).
 * - `crashed`: the worker exited while it ran the file; a replacement serves the next one.
 * - `failed`: the file's `onEvents` threw, so the worker's state is unknown and it was replaced.
 * - `start-failed`: no worker could be started for the file (`error` is why, `exit` how the worker
 *   ended when that was the cause, `workerId` the worker whose start failed). After three failures in a row the pool starts no more workers; the files
 *   still waiting wait for any worker that is alive or still starting, and once none is, each gets
 *   the last failure's `error` and `workerId` (no worker took those files, so the id is the one
 *   their error belongs to).
 * - `aborted`: the pool was aborted or closed before the file finished.
 * @public
 */
export type PoolOutcome =
  | { readonly type: 'done'; readonly workerId: number; readonly done: FileDone }
  | { readonly type: 'crashed'; readonly workerId: number; readonly exit: WorkerExit }
  | { readonly type: 'failed'; readonly workerId: number; readonly error: unknown }
  | {
      readonly type: 'start-failed'
      readonly workerId: number
      readonly error: unknown
      readonly exit?: WorkerExit
    }
  | { readonly type: 'aborted' }

/**
 * A pool of workers. Requests are served in the order they were made.
 * @public
 */
export interface Pool {
  /** Resolves when the file has ended; never rejects. */
  run(request: FileRequest): Promise<PoolOutcome>
  /**
   * Says no more files will be requested (until then a worker that goes idle is kept for the next
   * one): from now on a worker that is idle with no file waiting is stopped at once, so shutdown
   * overlaps the files still running. `close` is still what waits for every worker. A `run` made
   * afterwards still works; its worker is stopped after the file.
   */
  drain(): void
  /**
   * Gives up the files still waiting for a worker (they resolve `aborted`) and leaves the ones
   * already running alone: no file starts from now on. A run that bails by test count uses it,
   * since a running file can't be cancelled before T5.12.
   */
  cancelQueued(): void
  /**
   * Aborts what is waiting or running (a running file's worker is killed at once), stops every
   * worker (`stop`, the teardown timeout, SIGTERM, SIGKILL) and resolves once all have exited.
   * Calling it again returns the same promise.
   */
  close(): Promise<void>
}

type EventHandler = (events: readonly WorkerEvent[]) => void | Promise<void>

/** One worker, as the pool tracks it. */
interface Slot {
  readonly id: number
  readonly key: WorkerKey
  readonly transport: Transport
  readonly connection: WorkerConnection
  /** Settles once the worker is gone: it has exited, or, for one that shares the process, the force signal has come. */
  readonly gone: Promise<unknown>
  /** Where the worker's events go: the running file's handler, or none between files. */
  readonly route: { handler: EventHandler | undefined }
  /** Whether it is running a file. */
  state: 'idle' | 'busy'
  /** Set once the worker is being stopped, or waited for after a kill; settles when it is gone. */
  stopped: Promise<unknown> | undefined
  /** How the worker ended, once the transport reports it (it is gone from then on). */
  exit: WorkerExit | undefined
  /** Whether it was running a file when it ended: that file takes the blame, not the run. */
  diedBusy: boolean
  /**
   * Why the pool killed it (`kill`): an abort, or a file past `fileTimeoutMs`. Set, the worker is
   * dying: it takes no more files and its exit is no news.
   */
  killedFor: 'abort' | 'deadline' | undefined
  /** How many files it has run, for `maxFilesPerWorker`. */
  files: number
}

interface Waiter {
  readonly request: FileRequest
  readonly resolve: (outcome: PoolOutcome) => void
}

/** A worker that is alive and neither being stopped nor killed: one that may take a file. */
function usable(slot: Slot): boolean {
  return slot.exit === undefined && slot.stopped === undefined && slot.killedFor === undefined
}

/** The limits of `options`, each checked: a number that makes no sense is `ORCH_BAD_OPTION`. */
function checkedLimits(options: PoolOptions): {
  readonly maxFilesPerWorker: number | undefined
  readonly memoryLimitBytes: number | undefined
  readonly fileTimeoutMs: number | undefined
} {
  const { maxFilesPerWorker, memoryLimitBytes } = options.recycle
  const { fileTimeoutMs } = options
  if (
    maxFilesPerWorker !== undefined &&
    !(Number.isSafeInteger(maxFilesPerWorker) && maxFilesPerWorker >= 1)
  ) {
    throw new OrchestratorError(
      'ORCH_BAD_OPTION',
      `recycle.maxFilesPerWorker must be a whole number of at least 1 (got ${String(maxFilesPerWorker)})`,
    )
  }
  if (memoryLimitBytes !== undefined && !(memoryLimitBytes >= 0)) {
    throw new OrchestratorError(
      'ORCH_BAD_OPTION',
      `recycle.memoryLimitBytes must be a number of bytes, 0 or more (got ${String(memoryLimitBytes)})`,
    )
  }
  if (fileTimeoutMs !== undefined && !(fileTimeoutMs > 0 && Number.isFinite(fileTimeoutMs))) {
    throw new OrchestratorError(
      'ORCH_BAD_OPTION',
      `fileTimeoutMs must be a number of milliseconds above 0 (got ${String(fileTimeoutMs)})`,
    )
  }
  return { maxFilesPerWorker, memoryLimitBytes, fileTimeoutMs }
}

/** A worker that failed to start; the pool stops starting after `MAX_START_FAILURES` in a row. */
interface StartFailure {
  /** How many starts have failed in a row, this one included. */
  readonly count: number
  readonly workerId: number
  readonly error: unknown
}

/** The `start-failed` outcome for `failure`. */
function startFailed(failure: Pick<StartFailure, 'workerId' | 'error'>): PoolOutcome {
  const { workerId, error } = failure
  const exit = workerExitOf(error)
  return { type: 'start-failed', workerId, error, ...(exit === undefined ? {} : { exit }) }
}

function isWorkerExit(value: unknown): value is WorkerExit {
  return typeof value === 'object' && value !== null && 'type' in value
}

/**
 * The `WorkerExit` inside an error that says a worker exited before or while it worked: a file
 * rejected by `ORCH_WORKER_EXITED`, or a start that ended in `ORCH_WORKER_EXITED` or
 * `ORCH_WORKER_START_TIMEOUT`. `undefined` for any other error.
 */
export function workerExitOf(error: unknown): WorkerExit | undefined {
  if (!(error instanceof OrchestratorError)) return undefined
  if (error.code !== 'ORCH_WORKER_EXITED' && error.code !== 'ORCH_WORKER_START_TIMEOUT') {
    return undefined
  }
  return isWorkerExit(error.cause) ? error.cause : undefined
}

/**
 * Creates a pool. A worker is started only when a file is waiting and fewer than `maxWorkers`
 * are alive (a worker that is stopping still counts until it has exited). A waiting file takes an
 * idle worker with an equal `WorkerKey`; if none is idle and the limit is reached, an idle worker
 * with another key is stopped to make room. Each worker runs one file at a time, so a crash
 * costs only that file.
 *
 * After a file whose `fileDone.leakedGlobals` is not empty, the worker is stopped rather than
 * reused (`recycle.onLeak`, default on; D22): the next file would see what the first left behind.
 *
 * Three workers in a row that fail to start end the starting (a worker that starts resets the
 * count). The pool then gives up only when no worker is alive or still starting: until then, the
 * files left wait for the workers that are, and the pool never fails a file a healthy worker could
 * run.
 *
 * A worker is also replaced after `recycle.maxFilesPerWorker` files, and after a file whose
 * `fileDone.memoryBytes` is over `recycle.memoryLimitBytes` (`0` replaces it after every file;
 * never for a worker of a transport with `sharesProcess`, whose memory is the coordinator's).
 * Both are decided once the file's outcome is known, so the worker is stopped in the background
 * and the next file goes to another one.
 *
 * A file still running `fileTimeoutMs` after it was sent has its worker killed; its outcome is
 * `crashed` with `{ type: 'timeout', phase: 'file', limitMs }`. A bad `recycle` or `fileTimeoutMs` throws
 * `ORCH_BAD_OPTION`.
 * @public
 */
export function createPool(options: PoolOptions, deps: PoolDeps): Pool {
  const { recycle } = options
  const { maxFilesPerWorker, memoryLimitBytes, fileTimeoutMs } = checkedLimits(options)
  const fileTimeout =
    fileTimeoutMs === undefined ? undefined : ({ phase: 'file', limitMs: fileTimeoutMs } as const)
  const recycleOnLeak = recycle.onLeak !== false
  const factory = deps.transport(options.kind)
  // TODO(T5.12): a file that can be cancelled lets a kill end an in-process worker, and this goes.
  const sharesProcess = factory.sharesProcess === true
  const maxWorkers = Math.min(
    Math.max(1, Math.floor(options.maxWorkers) || 1),
    factory.maxWorkers ?? Number.POSITIVE_INFINITY,
  )

  const slots = new Set<Slot>()
  const waiters: Waiter[] = []
  const spawns = new Set<Promise<void>>()
  /** Every stop under way, so `close` waits for workers that exited before it was called too. */
  const stops = new Set<Promise<unknown>>()
  /** The workers still starting, over every key. */
  let spawning = 0
  let nextWorkerId = 1
  /**
   * Per worker key: how many of its workers are still starting, and its latest failed start with
   * how many in a row (cleared by a start of that key that works). An entry exists only while
   * either is set.
   */
  const keyStates = new Map<string, { spawning: number; failure?: StartFailure | undefined }>()
  /** How many entries of `keyStates` hold a failure: `pump` scans the waiters only when some do. */
  let failedKeys = 0
  /** Settles when the force signal comes: what an in-process worker's wind-down is no longer waited for after. */
  const forced = Promise.withResolvers<'forced'>()
  let draining = false
  /** `cancelQueued` was called: a file asked for after it is not run. */
  let cancelled = false
  /** Aborted with the pool: kills the workers that have not said `ready` yet. */
  const controller = new AbortController()
  let closing: Promise<void> | undefined

  /**
   * The failure that ended the starting of `workerKey`'s workers, once `MAX_START_FAILURES` in a
   * row have happened. Another key's workers are unaffected: a project that cannot start must not
   * fail the files of one that can.
   */
  function exhausted(workerKey: WorkerKey): StartFailure | undefined {
    const failure = keyStates.get(workerKeyId(workerKey))?.failure
    return failure !== undefined && failure.count >= MAX_START_FAILURES ? failure : undefined
  }

  /** Reports an error no caller waits on: to `onError`, else thrown uncaught, as `connectWorker` does. */
  function report(error: unknown, kind: PoolErrorKind = 'other'): void {
    if (deps.onError !== undefined) deps.onError(error, kind)
    else
      queueMicrotask(() => {
        throw error
      })
  }

  /** Ends the worker, gracefully, and waits until it is gone. Never rejects. */
  async function stop(slot: Slot): Promise<void> {
    void (async (): Promise<void> => {
      try {
        await slot.transport.terminate(false)
      } catch (error) {
        // A transport that can't stop gracefully is killed; the failure is still reported.
        report(error)
        await slot.transport.terminate(true).catch(report)
      }
    })()
    await slot.gone
  }

  /** Notes that `slot` is being stopped, until `stopped` settles: it takes no more files, and `close` waits. */
  function track(slot: Slot, stopped: Promise<unknown>): void {
    slot.stopped = stopped
    stops.add(stopped)
    void stopped.finally(() => stops.delete(stopped))
  }

  /**
   * Stops an idle or finished worker, in the background. One that is being killed is not stopped
   * again, only waited for.
   */
  function retire(slot: Slot): void {
    if (slot.stopped !== undefined) return
    track(slot, slot.killedFor === undefined ? stop(slot) : slot.gone)
  }

  /**
   * Kills the worker, whatever it is doing. From now on it takes no file (so a file that finishes
   * in the same turn, its `fileDone` already on the way, keeps its own result and the next file is
   * not sent to a worker that is dying) and its exit is no news.
   */
  function kill(slot: Slot, cause: 'abort' | 'deadline'): void {
    slot.killedFor ??= cause
    // The transport reports a deadline kill as the exit, with the limit (`{ type: 'timeout' }`).
    void slot.transport.terminate(true, cause === 'deadline' ? fileTimeout : undefined)
  }

  /** The worker has exited: it takes up no place any more. */
  function forget(slot: Slot): void {
    slots.delete(slot)
    pump()
  }

  function settleWaiters(outcome: PoolOutcome): void {
    for (const waiter of waiters.splice(0)) waiter.resolve(outcome)
  }

  /** Kills every worker that is still alive, whatever it is doing, and aborts the pool. */
  function forceKill(): void {
    abort()
    for (const slot of slots) if (slot.exit === undefined) kill(slot, 'abort')
    forced.resolve('forced')
  }

  function abort(): void {
    if (controller.signal.aborted) return
    settleWaiters({ type: 'aborted' })
    // A worker running a file is killed at once; its `run` then rejects, which is `aborted`.
    for (const slot of slots) if (slot.state === 'busy') kill(slot, 'abort')
    // A worker still starting is killed too, rather than waited for.
    controller.abort()
  }

  /**
   * A worker that ended without being asked to, or ended badly while it was asked to stop, and
   * wasn't running a file (a running file takes the blame as `crashed`), is an error of the run.
   */
  function reportExit(slot: Slot): void {
    const { exit } = slot
    if (exit === undefined || slot.diedBusy || slot.killedFor !== undefined) return
    if (exit.type === 'exit' && exit.code === 0) return
    report(
      new OrchestratorError(
        'ORCH_WORKER_EXITED',
        `Worker ${slot.id} exited while it ran no file (${describeExit(exit)})`,
        { cause: exit },
      ),
      'worker-lost',
    )
  }

  /** Whether a worker of `workerKey` is alive (and not being stopped) or still starting: one that may take its file. */
  function canServe(workerKey: WorkerKey): boolean {
    if ((keyStates.get(workerKeyId(workerKey))?.spawning ?? 0) > 0) return true
    for (const slot of slots) if (usable(slot) && sameWorkerKey(slot.key, workerKey)) return true
    return false
  }

  /** Gives waiting files to idle workers, starts workers for the rest while there is room. */
  function pump(): void {
    if (controller.signal.aborted) return
    // Too many starts of a key failed in a row. Its files left fail only once no worker of that key
    // is left that could run them; while one is alive or starting, they wait for it. Other keys'
    // files are never touched.
    if (failedKeys > 0) {
      for (const waiter of [...waiters]) {
        const gaveUp = exhausted(waiter.request.key)
        if (gaveUp !== undefined && !canServe(waiter.request.key)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(startFailed(gaveUp))
        }
      }
    }
    for (let at = 0; at < waiters.length; ) {
      const waiter = waiters[at]
      if (waiter === undefined) break
      const waiterKey = waiter.request.key
      const idle = [...slots].find(
        (slot) => slot.state === 'idle' && usable(slot) && sameWorkerKey(slot.key, waiterKey),
      )
      if (idle !== undefined) {
        waiters.splice(at, 1)
        void execute(idle, waiter)
      } else if (failedKeys > 0 && exhausted(waiterKey) !== undefined) {
        // Waits for its own key's worker that is still alive; the files behind it go on.
        at++
      } else if (slots.size + spawning < maxWorkers) {
        waiters.splice(at, 1)
        const spawn = spawnFor(waiter)
        spawns.add(spawn)
        void spawn.finally(() => spawns.delete(spawn))
      } else {
        // At the limit, with no idle worker that fits: an idle one with another key makes room.
        const other = [...slots].find((slot) => slot.state === 'idle' && usable(slot))
        if (other !== undefined) retire(other)
        return
      }
    }
    // Nothing waits and nothing more will: an idle worker has no next file to be kept for.
    if (draining) {
      for (const slot of slots) if (slot.state === 'idle' && usable(slot)) retire(slot)
    }
  }

  async function spawnFor(waiter: Waiter): Promise<void> {
    spawning++
    const workerId = nextWorkerId++
    const { key } = waiter.request
    const keyId = workerKeyId(key)
    const state = keyStates.get(keyId) ?? { spawning: 0 }
    keyStates.set(keyId, state)
    state.spawning++
    const doneStarting = (): void => {
      spawning--
      state.spawning--
      if (state.spawning === 0 && state.failure === undefined) keyStates.delete(keyId)
    }
    const route: Slot['route'] = { handler: undefined }
    let slot: Slot
    try {
      const transport = await factory.create(deps.init(key, workerId), controller.signal)
      const connection = connectWorker(transport, {
        methods: deps.methods,
        onEvents: (events) =>
          route.handler !== undefined
            ? route.handler(events)
            : deps.onIdleEvents?.(workerId, events),
        ...(deps.onError === undefined
          ? {}
          : { onError: (error) => deps.onError?.(error, 'other') }),
      })
      slot = {
        id: workerId,
        key,
        transport,
        connection,
        // A kill can't end a worker that shares this process: what winds down in it is not waited
        // for once the force signal has come (without one, nothing races the never-settling promise).
        gone:
          sharesProcess && deps.forceSignal !== undefined
            ? Promise.race([connection.exited, forced.promise])
            : connection.exited,
        route,
        state: 'idle',
        stopped: undefined,
        exit: undefined,
        diedBusy: false,
        killedFor: undefined,
        files: 0,
      }
      transport.onExit((exit) => {
        slot.exit = exit
        slot.diedBusy = slot.state === 'busy'
      })
    } catch (error) {
      // A worker that was killed because the pool closed is not a start failure to count.
      if (controller.signal.aborted) {
        doneStarting()
        waiter.resolve({ type: 'aborted' })
        return
      }
      const failure: StartFailure = { count: (state.failure?.count ?? 0) + 1, workerId, error }
      if (state.failure === undefined) failedKeys++
      state.failure = failure
      doneStarting()
      waiter.resolve(startFailed(failure))
      pump()
      return
    }
    if (state.failure !== undefined) {
      state.failure = undefined
      failedKeys--
    }
    doneStarting()
    slots.add(slot)
    void slot.connection.exited.then(() => {
      reportExit(slot)
      forget(slot)
    })
    // `close` may have come while the worker was starting: it is stopped, and the file not run.
    if (controller.signal.aborted) waiter.resolve({ type: 'aborted' })
    else await execute(slot, waiter)
  }

  /**
   * Whether the worker must not take another file: it ran its share, or holds too much memory. A
   * worker that shares the process measures the whole coordinator, which no replacement frees
   * (Jest's `--runInBand` recycles nothing either): only the file count applies to it.
   */
  function worn(slot: Slot, done: FileDone): boolean {
    if (maxFilesPerWorker !== undefined && slot.files >= maxFilesPerWorker) return true
    return !sharesProcess && memoryLimitBytes !== undefined && done.memoryBytes > memoryLimitBytes
  }

  /**
   * Sends the file to the worker and resolves with its `fileDone`, or `'forced'` for an inline
   * worker that was given up on. The deadline and the event route end with the call, before the
   * pool hands the worker its next file (`pump` may set the route again).
   */
  async function send(slot: Slot, request: FileRequest): Promise<FileDone | 'forced'> {
    let deadline: NodeJS.Timeout | undefined
    try {
      await request.onStart?.(slot.id)
      if (fileTimeoutMs !== undefined) {
        // From when the job is sent: `onStart` is the run's own hook and may take a while.
        deadline = setTimeout(() => kill(slot, 'deadline'), fileTimeoutMs)
      }
      const running = slot.connection.run(request.job)
      if (!sharesProcess || deps.forceSignal === undefined) return await running
      const done = await Promise.race([running, forced.promise])
      // An inline worker can't be killed from outside: the file is given up on, and its `run`,
      // which settles whenever the worker ends, is no one's concern any more.
      if (done === 'forced') running.catch(() => {})
      return done
    } finally {
      clearTimeout(deadline)
      slot.route.handler = undefined
    }
  }

  /** Runs the waiter's file on `slot` and resolves the waiter with how it ended. */
  async function execute(slot: Slot, waiter: Waiter): Promise<void> {
    const { request } = waiter
    slot.state = 'busy'
    slot.route.handler = request.onEvents
    try {
      const done = await send(slot, request)
      if (done === 'forced') {
        waiter.resolve({ type: 'aborted' })
        return
      }
      slot.state = 'idle'
      slot.files++
      try {
        request.onDone?.(done)
      } catch (error) {
        report(error)
      }
      if ((done.leakedGlobals.length > 0 && recycleOnLeak) || worn(slot, done)) retire(slot)
      else pump()
      waiter.resolve({ type: 'done', workerId: slot.id, done })
    } catch (error) {
      const exit = workerExitOf(error)
      if (controller.signal.aborted) waiter.resolve({ type: 'aborted' })
      else if (exit !== undefined) {
        forget(slot)
        waiter.resolve({ type: 'crashed', workerId: slot.id, exit })
      } else {
        // The file's handler threw, or the link failed: the worker's state is unknown.
        slot.state = 'idle'
        retire(slot)
        waiter.resolve({ type: 'failed', workerId: slot.id, error })
      }
    }
  }

  if (deps.signal?.aborted === true) abort()
  else deps.signal?.addEventListener('abort', abort, { once: true })
  if (deps.forceSignal?.aborted === true) forceKill()
  else deps.forceSignal?.addEventListener('abort', forceKill, { once: true })

  return {
    run(request) {
      if (controller.signal.aborted || cancelled) return Promise.resolve({ type: 'aborted' })
      return new Promise<PoolOutcome>((resolve) => {
        waiters.push({ request, resolve })
        pump()
      })
    },
    drain() {
      draining = true
      pump()
    },
    cancelQueued() {
      cancelled = true
      settleWaiters({ type: 'aborted' })
      // Nothing more will come, and what is left is running: idle workers have no next file.
      draining = true
      pump()
    },
    close() {
      closing ??= (async () => {
        deps.signal?.removeEventListener('abort', abort)
        abort()
        await Promise.allSettled([...spawns])
        for (const slot of slots) retire(slot)
        try {
          // A force signal that comes while workers are still stopping must still reach them.
          await Promise.all([...stops])
        } finally {
          deps.forceSignal?.removeEventListener('abort', forceKill)
        }
      })()
      return closing
    },
  }
}
