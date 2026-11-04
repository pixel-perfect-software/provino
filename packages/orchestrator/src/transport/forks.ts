// The default transport (Track 9 §Pool 1): a child process per worker, with advanced
// serialization so `Map`, `Set`, `BigInt`, `Date` and typed arrays cross, and piped stdio so a
// crash's last words reach the coordinator. A native fault stays in the child.
import { fork } from 'node:child_process'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { childProcessLink } from '@provino/rpc'
import type {
  CoordinatorToWorker,
  TransportFactory,
  WorkerExit,
  WorkerToCoordinator,
} from '@provino/types'
import { createTransport, forwardStdio, printError, type TransportOptions } from './shared.ts'

/** How long after a child's exit its IPC channel may take to disconnect. */
const DISCONNECT_GRACE_MS = 1000

/**
 * Options for `forksTransport`.
 * @public
 */
export interface ForksTransportOptions extends TransportOptions {
  /** Node flags for the child. Default: this process's `execArgv`. */
  readonly execArgv?: readonly string[]
  /** The child's environment. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Starts each worker in a forked child process.
 * @public
 */
export function forksTransport(options: ForksTransportOptions): TransportFactory {
  const bootstrap = fileURLToPath(import.meta.resolve('@provino/orchestrator/worker/bootstrap'))
  return createTransport('forks', options, (entry) => {
    const child = fork(bootstrap, [entry], {
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [...(options.execArgv ?? process.execArgv)],
      env: options.env ?? process.env,
    })
    const stderr = forwardStdio(child, options)
    const link = childProcessLink<CoordinatorToWorker, WorkerToCoordinator>(child)
    return {
      link,
      pid: child.pid,
      // The exit is reported once the child has exited *and* its IPC channel has disconnected,
      // so every message it sent first has arrived. A grandchild holding the channel open could
      // delay the disconnect forever, so after the exit it gets a short grace, then is ignored.
      onExit(listener) {
        let exit: WorkerExit | undefined
        let disconnected = false
        let grace: NodeJS.Timeout | undefined
        const report = (): void => {
          if (exit === undefined || !disconnected) return
          clearTimeout(grace)
          listener(exit)
        }
        link.onExit(() => {
          disconnected = true
          report()
        })
        // A spawn failure has no `exit` event; any later `error` (a send on a closing channel)
        // is reported by the exit that follows it.
        child.on('error', (error) => {
          if (child.pid !== undefined) return
          printError(stderr, error)
          exit = { type: 'exit', code: 1 }
          disconnected = true
          report()
        })
        child.once('exit', (code, signal) => {
          exit =
            signal !== null
              ? { type: 'signal', signal, likelyOom: signal === 'SIGABRT' }
              : { type: 'exit', code: code ?? 0 }
          grace = setTimeout(() => {
            disconnected = true
            report()
          }, DISCONNECT_GRACE_MS).unref()
          report()
        })
      },
      kill(signal) {
        child.kill(signal)
      },
    }
  })
}
