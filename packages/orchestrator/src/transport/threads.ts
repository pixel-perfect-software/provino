// Opt-in `pool: 'threads'` (Track 9 §Pool 1): about 35 MiB less per worker, a clean OOM through
// `resourceLimits`, and no isolation from a native fault, which ends the whole process.
import { Worker } from 'node:worker_threads'
import { workerLink } from '@provino/rpc'
import type {
  CoordinatorToWorker,
  TransportFactory,
  WorkerExit,
  WorkerToCoordinator,
} from '@provino/types'
import { connect, entryHref, type TransportOptions } from './shared.ts'

/**
 * Options for `threadsTransport`.
 * @public
 */
export interface ThreadsTransportOptions extends TransportOptions {
  /**
   * Node flags for the thread. Default: inherited from this thread. Only set them when needed: a
   * thread rejects flags that affect the whole process.
   */
  readonly execArgv?: readonly string[]
  /** The thread's `process.env`, a copy. Default: a copy of this process's. */
  readonly env?: NodeJS.ProcessEnv
  /** The thread's old-generation heap limit; going over it ends the thread with `oom`. */
  readonly memoryLimitMb?: number
}

/**
 * Starts each worker in a worker thread.
 * @public
 */
export function threadsTransport(options: ThreadsTransportOptions): TransportFactory {
  const bootstrap = new URL(import.meta.resolve('@provino/orchestrator/worker/bootstrap'))
  const entry = entryHref(options.entry)
  return {
    kind: 'threads',
    async create(init) {
      const worker = new Worker(bootstrap, {
        workerData: { entry },
        stdout: true,
        stderr: true,
        env: options.env ?? process.env,
        ...(options.execArgv === undefined ? {} : { execArgv: [...options.execArgv] }),
        ...(options.memoryLimitMb === undefined
          ? {}
          : { resourceLimits: { maxOldGenerationSizeMb: options.memoryLimitMb } }),
      })
      worker.stdout.pipe(options.stdout ?? process.stdout, { end: false })
      worker.stderr.pipe(options.stderr ?? process.stderr, { end: false })
      let exitListener: ((exit: WorkerExit) => void) | undefined
      let outOfMemory = false
      // An uncaught error ends the thread with code 1, which the exit reports; only the OOM code
      // changes what the exit means.
      worker.on('error', (error: unknown) => {
        if ((error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY') outOfMemory = true
      })
      worker.once('exit', (code) => {
        exitListener?.(
          outOfMemory && options.memoryLimitMb !== undefined
            ? { type: 'oom', limitMb: options.memoryLimitMb }
            : { type: 'exit', code },
        )
      })
      return await connect(
        'threads',
        {
          link: workerLink<CoordinatorToWorker, WorkerToCoordinator>(worker),
          pid: undefined,
          onExit(listener) {
            exitListener = listener
          },
          kill() {
            void worker.terminate()
          },
        },
        init,
        options,
      )
    },
  }
}
