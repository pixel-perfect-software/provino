// `--runInBand` (Track 9 §Lifecycle): the worker entry runs in the coordinator's own process,
// over a `MessageChannel`, so messages are structured-cloned exactly as they are for a fork or a
// thread. Nothing isolates it: `process.exit` in an inline worker ends the coordinator.
import { MessageChannel } from 'node:worker_threads'
import { messagePortLink } from '@provino/rpc'
import type {
  CoordinatorToWorker,
  TransportFactory,
  WorkerExit,
  WorkerMain,
  WorkerPort,
  WorkerToCoordinator,
} from '@provino/types'
import { OrchestratorError } from '../errors.ts'
import { checkInit, connect, entryHref, type TransportOptions } from './shared.ts'

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
  const entry = entryHref(options.entry)
  return {
    kind: 'inline',
    async create(init) {
      checkInit('inline', init)
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
      let exitListener: ((exit: WorkerExit) => void) | undefined
      link.onExit(() => exitListener?.({ type: 'exit', code: failed ? 1 : 0 }))
      // Like an uncaught error in a fork: print it, then the worker is gone.
      void Promise.resolve()
        .then(() => (main as WorkerMain)(workerPort))
        .catch((error: unknown) => {
          failed = true
          ;(options.stderr ?? process.stderr).write(`${String((error as Error)?.stack ?? error)}\n`)
          workerPort.close()
        })
      return await connect(
        'inline',
        {
          link,
          pid: undefined,
          onExit(listener) {
            exitListener = listener
          },
          kill() {
            link.close()
          },
        },
        init,
        options,
      )
    },
  }
}
