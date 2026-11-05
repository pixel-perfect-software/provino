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
import { sameWorkerKey } from './key.ts'

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
   * is over. Without it the error is thrown, uncaught.
   */
  readonly onError?: (error: unknown) => void
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
 * - `start-failed`: no worker could be started for the file (`error` is why, `workerId` the worker
 *   whose start failed). After three failures in a row the pool starts no more workers; the files
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
  | { readonly type: 'start-failed'; readonly workerId: number; readonly error: unknown }
  | { readonly type: 'aborted' }

/**
 * A pool of workers. Requests are served in the order they were made.
 * @public
 */
export interface Pool {
  /** Resolves when the file has ended; never rejects. */
  run(request: FileRequest): Promise<PoolOutcome>
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
  state: 'idle' | 'busy' | 'stopping'
  /** Set the moment the transport reports the worker's exit. */
  dead: boolean
  /** Settles when the worker has been told to stop and has exited. */
  stopped: Promise<void> | undefined
}

interface Waiter {
  readonly request: FileRequest
  readonly resolve: (outcome: PoolOutcome) => void
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
  const maxWorkers = Math.max(1, Math.floor(options.maxWorkers) || 1)
  const factory = deps.transport(options.kind)

  const slots = new Set<Slot>()
  const waiters: Waiter[] = []
  const spawns = new Set<Promise<void>>()
  let spawning = 0
  let nextWorkerId = 1
  let startFailures = 0
  /** Set while the last `MAX_START_FAILURES` or more starts in a row have failed: the latest one. */
  let exhausted: { readonly workerId: number; readonly error: unknown } | undefined
  let aborted = false
  let closing: Promise<void> | undefined

  /** Reports an error no caller waits on: to `onError`, else thrown uncaught, as `connectWorker` does. */
  function report(error: unknown): void {
    if (deps.onError !== undefined) deps.onError(error)
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
    if (slot.state === 'stopping') return
    slot.state = 'stopping'
    slot.stopped = stop(slot)
  }

  /** The worker has exited: it takes up no place any more. */
  function forget(slot: Slot): void {
    slot.dead = true
    slots.delete(slot)
    pump()
  }

  function settleWaiters(outcome: PoolOutcome): void {
    for (const waiter of waiters.splice(0)) waiter.resolve(outcome)
  }

  function abort(): void {
    if (aborted) return
    aborted = true
    settleWaiters({ type: 'aborted' })
    // A worker running a file is killed at once; its `run` then rejects, which is `aborted`.
    for (const slot of slots) {
      if (slot.state === 'busy') void slot.transport.terminate(true)
    }
  }

  /** Whether a worker is alive (and not being stopped) or still starting: one that may take a file. */
  function canServe(): boolean {
    if (spawning > 0) return true
    for (const slot of slots) {
      if (slot.state !== 'stopping' && !slot.dead) return true
    }
    return false
  }

  /** Gives waiting files to idle workers, starts workers for the rest while there is room. */
  function pump(): void {
    if (aborted) return
    // Too many starts failed in a row. The files left fail only once no worker is left that could
    // run them; while one is alive or starting, they wait for it.
    if (exhausted !== undefined && !canServe()) {
      settleWaiters({ type: 'start-failed', ...exhausted })
      return
    }
    for (let waiter = waiters[0]; waiter !== undefined; waiter = waiters[0]) {
      const idle = [...slots].find(
        (slot) =>
          slot.state === 'idle' && !slot.dead && sameWorkerKey(slot.key, waiter.request.key),
      )
      if (idle !== undefined) {
        waiters.shift()
        void execute(idle, waiter)
      } else if (exhausted === undefined && slots.size + spawning < maxWorkers) {
        waiters.shift()
        const spawn = spawnFor(waiter)
        spawns.add(spawn)
        void spawn.finally(() => spawns.delete(spawn))
      } else {
        // At the limit, with no idle worker that fits: an idle one with another key makes room.
        const other = [...slots].find((slot) => slot.state === 'idle' && !slot.dead)
        if (other !== undefined) retire(other)
        return
      }
    }
  }

  async function spawnFor(waiter: Waiter): Promise<void> {
    spawning++
    const workerId = nextWorkerId++
    const { key } = waiter.request
    const route: Slot['route'] = { handler: undefined }
    let slot: Slot
    try {
      const transport = await factory.create(deps.init(key, workerId))
      const connection = connectWorker(transport, {
        methods: deps.methods,
        onEvents: (events) =>
          route.handler !== undefined
            ? route.handler(events)
            : deps.onIdleEvents?.(workerId, events),
        ...(deps.onError === undefined ? {} : { onError: deps.onError }),
      })
      slot = {
        id: workerId,
        key,
        transport,
        connection,
        route,
        state: 'idle',
        dead: false,
        stopped: undefined,
      }
      transport.onExit(() => {
        slot.dead = true
      })
    } catch (error) {
      spawning--
      // A worker that was killed because the pool closed is not a start failure to count.
      if (aborted) {
        waiter.resolve({ type: 'aborted' })
        return
      }
      startFailures++
      if (startFailures >= MAX_START_FAILURES) exhausted = { workerId, error }
      waiter.resolve({ type: 'start-failed', workerId, error })
      pump()
      return
    }
    spawning--
    startFailures = 0
    exhausted = undefined
    slots.add(slot)
    void slot.connection.exited.then(() => forget(slot))
    // `close` may have come while the worker was starting: it is stopped, and the file not run.
    if (aborted) waiter.resolve({ type: 'aborted' })
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
      if (done.leakedGlobals.length > 0 && recycleOnLeak) retire(slot)
      else {
        slot.state = 'idle'
        pump()
      }
      waiter.resolve({ type: 'done', workerId: slot.id, done })
    } catch (error) {
      slot.route.handler = undefined
      const exit = workerExitOf(error)
      if (aborted) waiter.resolve({ type: 'aborted' })
      else if (exit !== undefined) {
        forget(slot)
        waiter.resolve({ type: 'crashed', workerId: slot.id, exit })
      } else {
        // The file's handler threw, or the link failed: the worker's state is unknown.
        retire(slot)
        waiter.resolve({ type: 'failed', workerId: slot.id, error })
      }
    }
  }

  if (deps.signal?.aborted === true) aborted = true
  else deps.signal?.addEventListener('abort', abort, { once: true })

  return {
    run(request) {
      if (aborted) return Promise.resolve({ type: 'aborted' })
      return new Promise<PoolOutcome>((resolve) => {
        waiters.push({ request, resolve })
        pump()
      })
    },
    close() {
      closing ??= (async () => {
        deps.signal?.removeEventListener('abort', abort)
        abort()
        await Promise.allSettled([...spawns])
        const everyone = [...slots]
        for (const slot of everyone) retire(slot)
        await Promise.all(everyone.map((slot) => slot.stopped))
      })()
      return closing
    },
  }
}
