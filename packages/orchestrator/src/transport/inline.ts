// `--runInBand` (Track 9 §Lifecycle): the worker entry runs in the coordinator's own process,
// over a `MessageChannel`, so messages are structured-cloned exactly as they are for a fork or a
// thread. Nothing isolates it: `process.exit` in an inline worker ends the coordinator.
//
// What "the worker ended" means here is what the bootstrap of a fork or a thread waits for: the
// entry's `main` has settled and the link has closed. Killing one only closes the coordinator's end
// of the link; the worker is told by its port's `close` event and tears itself down (`startWorker`'s
// best-effort `runner.stop`), and `main` settles after that. The exit is reported then, so the next
// inline worker in this process can install what this one released. A file that can't be cancelled
// (T5.12) holds that stop back, so the wait is bounded by the teardown timeout.
import { MessageChannel } from 'node:worker_threads'
import { messagePortLink } from '@provino/rpc'
import type {
  CoordinatorToWorker,
  TransportFactory,
  WorkerMain,
  WorkerPort,
  WorkerToCoordinator,
} from '@provino/types'
import { OrchestratorError } from '../errors.ts'
import {
  createTransport,
  printError,
  settlesWithin,
  type TransportOptions,
  teardownTimeoutOf,
} from './shared.ts'

/**
 * Options for `inlineTransport`. An inline worker shares this process's stdio, so the `stdout`
 * and `stderr` options are only used to report a worker main that throws.
 * @public
 */
export type InlineTransportOptions = TransportOptions

/**
 * Runs each worker in this process (`sharesProcess`). At most one is alive at a time
 * (`maxWorkers: 1`).
 * @public
 */
export function inlineTransport(options: InlineTransportOptions): TransportFactory {
  const factory = createTransport('inline', options, async (entry) => {
    const loaded: unknown = await import(entry)
    const main = (loaded as { readonly default?: unknown }).default
    if (typeof main !== 'function') {
      throw new OrchestratorError(
        'ORCH_BAD_ENTRY',
        `The worker entry ${entry} has no default-exported function`,
      )
    }
    const { port1, port2 } = new MessageChannel()
    const link = messagePortLink<CoordinatorToWorker, WorkerToCoordinator>(port1)
    const workerPort: WorkerPort = messagePortLink(port2)
    let failed = false
    const teardownTimeoutMs = teardownTimeoutOf(options)
    // Settles when `main` has returned or thrown. A main that throws is like an uncaught error in a
    // fork: print it, then the worker is gone.
    const mainSettled = Promise.resolve()
      .then(() => (main as WorkerMain)(workerPort))
      .catch((error: unknown) => {
        failed = true
        printError(options.stderr ?? process.stderr, error)
        workerPort.close()
      })
    return {
      link,
      pid: undefined,
      onExit(listener) {
        link.onExit(() => {
          // The link is closed; the worker has ended once its main has settled too. Past the
          // bound it is reported as it is. The bound's timer is ref'd: a main stuck on a promise
          // holds no handle, so an unref'd one would let the loop drain before the exit is
          // reported, and `terminate` would never resolve.
          void settlesWithin(mainSettled, teardownTimeoutMs, { ref: true }).then(() =>
            listener({ type: 'exit', code: failed ? 1 : 0 }),
          )
        })
      },
      kill() {
        // Closing our end closes the worker's too; it hears of it as a `close` event on its port.
        link.close()
      },
    }
  })
  return { ...factory, maxWorkers: 1, sharesProcess: true }
}
