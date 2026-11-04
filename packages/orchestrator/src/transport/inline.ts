// `--runInBand` (Track 9 §Lifecycle): the worker entry runs in the coordinator's own process,
// over a `MessageChannel`, so messages are structured-cloned exactly as they are for a fork or a
// thread. Nothing isolates it: `process.exit` in an inline worker ends the coordinator. Killing one
// closes both ends of its link, and the worker, told at once, tears itself down (`startWorker`'s
// best-effort `runner.stop`).
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
import { createTransport, printError, type TransportOptions } from './shared.ts'

/**
 * Options for `inlineTransport`. An inline worker shares this process's stdio, so the `stdout`
 * and `stderr` options are only used to report a worker main that throws.
 * @public
 */
export type InlineTransportOptions = TransportOptions

/**
 * Runs each worker in this process.
 * @public
 */
export function inlineTransport(options: InlineTransportOptions): TransportFactory {
  return createTransport('inline', options, async (entry) => {
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
    // Like an uncaught error in a fork: print it, then the worker is gone.
    void Promise.resolve()
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
        link.onExit(() => listener({ type: 'exit', code: failed ? 1 : 0 }))
      },
      kill() {
        // Both ends, now. Closing only ours would tell the worker later (a port's `close` event
        // arrives after the next worker's whole handshake could have), and an inline worker is in
        // this process: its `runner.stop`, which frees the matcher slot, must start before the
        // next inline worker boots.
        workerPort.close()
        link.close()
      },
    }
  })
}
