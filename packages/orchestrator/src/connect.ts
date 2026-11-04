// The coordinator's half of one worker: it serves `CoordinatorMethods`, hands each pack's events
// on in order, and acks a pack only once its handler has settled, so a slow reporter slows the
// worker (Track 9 §RPC, back-pressure). The pool (T9.5) holds one of these per worker.
import { createRpc, type RpcHandlers } from '@provino/rpc'
import type {
  CoordinatorMethods,
  FileJob,
  RpcClient,
  Transport,
  WorkerEvent,
  WorkerExit,
  WorkerMethods,
  WorkerToCoordinator,
} from '@provino/types'
import { OrchestratorError } from './errors.ts'
import { describeExit } from './transport/shared.ts'

/**
 * A worker's report that a file is done: it follows the file's last pack.
 * @public
 */
export type FileDone = Extract<WorkerToCoordinator, { readonly t: 'fileDone' }>

/**
 * Options for `connectWorker`.
 * @public
 */
export interface ConnectWorkerOptions {
  /** The coordinator methods this worker may call. */
  readonly methods: RpcHandlers<CoordinatorMethods>
  /**
   * Receives each pack's events, in order. The pack is acked once this settles; if it throws,
   * the pack is still acked and the file being run rejects with the error.
   */
  readonly onEvents: (events: readonly WorkerEvent[]) => void | Promise<void>
}

/**
 * One connected worker, seen from the coordinator.
 * @public
 */
export interface WorkerConnection {
  readonly transport: Transport
  /** Calls into the worker. */
  readonly worker: RpcClient<WorkerMethods>
  /**
   * Runs one file. Resolves with its `fileDone` once every event before it has been handed to
   * `onEvents`; rejects with `ORCH_WORKER_EXITED` (the `WorkerExit` as `cause`) if the worker
   * exits first.
   */
  run(job: FileJob): Promise<FileDone>
  cancel(reason: 'sigint' | 'bail' | 'watch-rerun'): void
  /** Resolves with the worker's exit. */
  readonly exited: Promise<WorkerExit>
}

interface Running {
  resolve(done: FileDone): void
  reject(error: unknown): void
}

/**
 * Connects to a worker that its transport has started.
 * @public
 */
export function connectWorker(
  transport: Transport,
  options: ConnectWorkerOptions,
): WorkerConnection {
  const worker = createRpc<CoordinatorMethods, WorkerMethods>(transport, options.methods)
  const running = new Map<number, Running>()
  let nextSeq = 0
  let exit: WorkerExit | undefined
  /** Event delivery, acks and file completions, strictly in arrival order. */
  let chain: Promise<void> = Promise.resolve()
  /** The first `onEvents` failure since the last `fileDone`. */
  let failure: { readonly error: unknown } | undefined

  transport.onMessage((message) => {
    if (message.t === 'pack') {
      chain = chain
        .then(() => options.onEvents(message.events))
        .catch((error: unknown) => {
          failure ??= { error }
        })
        .then(() => transport.send({ t: 'ack', pack: message.pack }))
    } else if (message.t === 'fileDone') {
      chain = chain.then(() => {
        const file = running.get(message.seq)
        if (file === undefined) return
        running.delete(message.seq)
        const failed = failure
        failure = undefined
        if (failed === undefined) file.resolve(message)
        else file.reject(failed.error)
      })
    }
  })

  const exited = new Promise<WorkerExit>((resolve) => {
    transport.onExit((workerExit) => {
      chain = chain.then(() => {
        exit = workerExit
        for (const file of running.values()) file.reject(exitedError(workerExit))
        running.clear()
        resolve(workerExit)
      })
    })
  })

  return {
    transport,
    worker,
    run(job) {
      if (exit !== undefined) return Promise.reject(exitedError(exit))
      const seq = nextSeq++
      return new Promise<FileDone>((resolve, reject) => {
        running.set(seq, { resolve, reject })
        transport.send({ t: 'run', seq, job })
      })
    },
    cancel(reason) {
      transport.send({ t: 'cancel', reason })
    },
    exited,
  }
}

function exitedError(exit: WorkerExit): OrchestratorError {
  return new OrchestratorError(
    'ORCH_WORKER_EXITED',
    `The worker exited while running a file (${describeExit(exit)})`,
    { cause: exit },
  )
}
