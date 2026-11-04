// Opt-in `pool: 'threads'` (Track 9 §Pool 1): about 35 MiB less per worker, a clean OOM through
// `resourceLimits`, and no isolation from a native fault, which ends the whole process.
import { Worker } from 'node:worker_threads'
import { workerLink } from '@provino/rpc'
import type { CoordinatorToWorker, TransportFactory, WorkerToCoordinator } from '@provino/types'
import { createTransport, forwardStdio, printError, type TransportOptions } from './shared.ts'

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
  const limitMb = options.memoryLimitMb
  return createTransport('threads', options, (entry) => {
    const worker = new Worker(bootstrap, {
      workerData: { entry },
      stdout: true,
      stderr: true,
      env: options.env ?? process.env,
      ...(options.execArgv === undefined ? {} : { execArgv: [...options.execArgv] }),
      ...(limitMb === undefined ? {} : { resourceLimits: { maxOldGenerationSizeMb: limitMb } }),
    })
    const stderr = forwardStdio(worker, options)
    let outOfMemory = false
    // An uncaught error ends the thread with code 1, which the exit reports. Node prints it
    // nowhere, so it goes to the stderr sink, as a fork's would; only the OOM code changes what
    // the exit means.
    worker.on('error', (error: unknown) => {
      if ((error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY') outOfMemory = true
      else printError(stderr, error)
    })
    return {
      link: workerLink<CoordinatorToWorker, WorkerToCoordinator>(worker),
      pid: undefined,
      onExit(listener) {
        worker.once('exit', (code) => {
          listener(
            outOfMemory && limitMb !== undefined
              ? { type: 'oom', limitMb }
              : { type: 'exit', code },
          )
        })
      },
      kill() {
        void worker.terminate()
      },
    }
  })
}
