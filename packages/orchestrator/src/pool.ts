// T9.5, minimal (Track 9 §Pool): lazy spawn up to `maxWorkers`, warm reuse by `WorkerKey`, one
// file in flight per worker, a crash charged to the one file that was running, and a worker that
// leaked globals replaced (D22). Recycling on memory or file count, and the per-file hang
// timeout, are B21's.
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
  /** Where the worker's events go: the running file's handler, or none between files. */
  readonly route: { handler: EventHandler | undefined }
  /** Whether it is running a file. */
  state: 'idle' | 'busy'
  /** Set once the worker is being stopped; settles when it has exited. */
  stopped: Promise<void> | undefined
  /** How the worker ended, once the transport reports it (it is gone from then on). */
  exit: WorkerExit | undefined
  /** Whether it was running a file when it ended: that file takes the blame, not the run. */
  diedBusy: boolean
  /** Whether the pool itself killed it (an abort), so its exit is no news. */
  killed: boolean
}

interface Waiter {
  readonly request: FileRequest
  readonly resolve: (outcome: PoolOutcome) => void
}

/** A worker that is alive and not being stopped: one that may take a file. */
function usable(slot: Slot): boolean {
  return slot.exit === undefined && slot.stopped === undefined
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
 * `recycle.memoryLimitBytes` and `recycle.maxFilesPerWorker` are not built (T9.5, B21); setting
 * either throws `ORCH_NOT_IMPLEMENTED`.
 * @public
 */
export function createPool(options: PoolOptions, deps: PoolDeps): Pool {
  const { recycle } = options
  if (recycle.memoryLimitBytes !== undefined || recycle.maxFilesPerWorker !== undefined) {
    throw new OrchestratorError(
      'ORCH_NOT_IMPLEMENTED',
      'Recycling a worker on memory or file count is not built yet; it arrives with T9.5 (B21)',
    )
  }
  const recycleOnLeak = recycle.onLeak !== false
  const factory = deps.transport(options.kind)
  const maxWorkers = Math.min(
    Math.max(1, Math.floor(options.maxWorkers) || 1),
    factory.maxWorkers ?? Number.POSITIVE_INFINITY,
  )

  const slots = new Set<Slot>()
  const waiters: Waiter[] = []
  const spawns = new Set<Promise<void>>()
  /** Every stop under way, so `close` waits for workers that exited before it was called too. */
  const stops = new Set<Promise<void>>()
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
  let draining = false
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

  /** Ends the worker and waits for its exit. Never rejects. */
  async function stop(slot: Slot): Promise<void> {
    try {
      await slot.transport.terminate(false)
    } catch (error) {
      // A transport that can't stop gracefully is killed; the failure is still reported.
      report(error)
      await slot.transport.terminate(true).catch(report)
    }
    await slot.connection.exited
  }

  /** Stops an idle or finished worker, in the background. */
  function retire(slot: Slot): void {
    if (slot.stopped !== undefined) return
    const stopped = stop(slot)
    slot.stopped = stopped
    stops.add(stopped)
    void stopped.finally(() => stops.delete(stopped))
  }

  /** The worker has exited: it takes up no place any more. */
  function forget(slot: Slot): void {
    slots.delete(slot)
    pump()
  }

  function settleWaiters(outcome: PoolOutcome): void {
    for (const waiter of waiters.splice(0)) waiter.resolve(outcome)
  }

  function abort(): void {
    if (controller.signal.aborted) return
    settleWaiters({ type: 'aborted' })
    // A worker running a file is killed at once; its `run` then rejects, which is `aborted`.
    for (const slot of slots) {
      if (slot.state === 'busy') {
        slot.killed = true
        void slot.transport.terminate(true)
      }
    }
    // A worker still starting is killed too, rather than waited for.
    controller.abort()
  }

  /**
   * A worker that ended without being asked to, or ended badly while it was asked to stop, and
   * wasn't running a file (a running file takes the blame as `crashed`), is an error of the run.
   */
  function reportExit(slot: Slot): void {
    const { exit } = slot
    if (exit === undefined || slot.diedBusy || slot.killed) return
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
    let state = keyStates.get(keyId)
    if (state === undefined) keyStates.set(keyId, (state = { spawning: 0 }))
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
        route,
        state: 'idle',
        stopped: undefined,
        exit: undefined,
        diedBusy: false,
        killed: false,
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

  /** Runs the waiter's file on `slot` and resolves the waiter with how it ended. */
  async function execute(slot: Slot, waiter: Waiter): Promise<void> {
    const { request } = waiter
    slot.state = 'busy'
    slot.route.handler = request.onEvents
    try {
      await request.onStart?.(slot.id)
      const done = await slot.connection.run(request.job)
      slot.route.handler = undefined
      slot.state = 'idle'
      if (done.leakedGlobals.length > 0 && recycleOnLeak) retire(slot)
      else pump()
      waiter.resolve({ type: 'done', workerId: slot.id, done })
    } catch (error) {
      slot.route.handler = undefined
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

  return {
    run(request) {
      if (controller.signal.aborted) return Promise.resolve({ type: 'aborted' })
      return new Promise<PoolOutcome>((resolve) => {
        waiters.push({ request, resolve })
        pump()
      })
    },
    drain() {
      draining = true
      pump()
    },
    close() {
      closing ??= (async () => {
        deps.signal?.removeEventListener('abort', abort)
        abort()
        await Promise.allSettled([...spawns])
        for (const slot of slots) retire(slot)
        await Promise.all([...stops])
      })()
      return closing
    },
  }
}
