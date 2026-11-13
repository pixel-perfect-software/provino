// Opt-in `pool: 'threads'` (Track 9 §Pool 1): about 35 MiB less per worker, a clean OOM through
// `resourceLimits`, and no isolation from a native fault, which ends the whole process.
import { getHeapStatistics } from 'node:v8'
import { Worker } from 'node:worker_threads'
import { workerLink } from '@provino/rpc'
import type {
  CoordinatorToWorker,
  TransportFactory,
  WorkerExit,
  WorkerToCoordinator,
} from '@provino/types'
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
  /**
   * The thread's old-generation heap limit; going over it ends the thread with `oom` and this
   * limit. Without one the thread runs under Node's default, and an OOM is `oom` all the same.
   */
  readonly memoryLimitMb?: number
}

/**
 * How a thread that ended with `code` ended. A thread that went over its heap limit has `oom` and
 * the limit it ran under: the one the transport set, else the one Node gave it (`limitMb`), else
 * V8's default for this process, as a fork has.
 */
export function threadExit(
  code: number,
  outOfMemory: boolean,
  limitMb: number | undefined,
): WorkerExit {
  if (!outOfMemory) return { type: 'exit', code }
  return {
    type: 'oom',
    limitMb: limitMb ?? Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024)),
  }
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
    // Node fills in the limits a thread runs under once it is online, and empties them when it
    // stops, so an OOM with no configured limit reads its limit here, early.
    let runningLimitMb = limitMb
    worker.once('online', () => {
      const actual = worker.resourceLimits?.maxOldGenerationSizeMb
      if (limitMb === undefined && actual !== undefined && actual > 0) runningLimitMb = actual
    })
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
          listener(threadExit(code, outOfMemory, runningLimitMb))
        })
      },
      kill() {
        void worker.terminate()
      },
    }
  })
}
