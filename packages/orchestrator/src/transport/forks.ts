// The default transport (Track 9 §Pool 1): a child process per worker, with advanced
// serialization so `Map`, `Set`, `BigInt`, `Date` and typed arrays cross, and piped stdio so a
// crash's last words reach the coordinator. A native fault stays in the child.
import { fork } from 'node:child_process'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { getHeapStatistics } from 'node:v8'
import { childProcessLink } from '@provino/rpc'
import type {
  CoordinatorToWorker,
  TransportFactory,
  WorkerExit,
  WorkerToCoordinator,
} from '@provino/types'
import { createTransport, forwardStdio, printError, type TransportOptions } from './shared.ts'
import { createStderrWatch } from './stderr-watch.ts'

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
  /**
   * The child's old-generation heap limit, as `--max-old-space-size` (added to `execArgv`, and
   * replacing one it already has). A child that goes over it ends with `oom` and this limit.
   * Default: the flags' own, else V8's.
   */
  readonly memoryLimitMb?: number
}

/**
 * The heap limit a child started with `execArgv` has, in MB: its `--max-old-space-size` (the last
 * one, as V8 reads them), else the default of this process, which a child shares.
 */
function heapLimitMb(execArgv: readonly string[]): number {
  for (const flag of execArgv.toReversed()) {
    const match = /^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(flag)
    if (match !== null) return Number(match[1])
  }
  return Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024))
}

/** The child's flags: `execArgv`, with the memory limit's `--max-old-space-size` last, if given. */
function execArgvOf(options: ForksTransportOptions): string[] {
  const flags = [...(options.execArgv ?? process.execArgv)]
  if (options.memoryLimitMb === undefined) return flags
  return [...flags, `--max-old-space-size=${options.memoryLimitMb}`]
}

/**
 * How a child that was killed by `signal` ended. V8 aborts (SIGABRT) a process that is out of heap
 * after printing a fatal error, and so does a `process.abort()`; its stderr says which (`sawHeapOom`:
 * the fatal error went by, wherever in the stream). A SIGABRT without that line is `likelyOom`,
 * as before.
 */
function signalExit(signal: NodeJS.Signals, sawHeapOom: boolean, limitMb: number): WorkerExit {
  if (signal === 'SIGABRT' && sawHeapOom) return { type: 'oom', limitMb }
  return { type: 'signal', signal, likelyOom: signal === 'SIGABRT' }
}

/**
 * Starts each worker in a forked child process.
 * @public
 */
export function forksTransport(options: ForksTransportOptions): TransportFactory {
  const bootstrap = fileURLToPath(import.meta.resolve('@provino/orchestrator/worker/bootstrap'))
  return createTransport('forks', options, (entry) => {
    const execArgv = execArgvOf(options)
    const child = fork(bootstrap, [entry], {
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv,
      env: options.env ?? process.env,
    })
    const stderr = forwardStdio(child, options)
    const watch = createStderrWatch()
    child.stderr?.on('data', (chunk: Buffer) => {
      watch.push(chunk.toString())
    })
    const link = childProcessLink<CoordinatorToWorker, WorkerToCoordinator>(child)
    return {
      link,
      pid: child.pid,
      // The exit is reported once the child has exited, its IPC channel has disconnected *and* its
      // stdio has closed, so every message and every line of stderr it sent first has arrived (the
      // OOM check reads the last of them). A grandchild holding the channel or a pipe open could
      // delay that forever, so after the exit it gets a short grace, then is ignored.
      onExit(listener) {
        let ended:
          | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
          | undefined
        let disconnected = false
        let stdioClosed = false
        let grace: NodeJS.Timeout | undefined
        let failed = false
        const report = (): void => {
          if (ended === undefined || !disconnected || !stdioClosed) return
          clearTimeout(grace)
          listener(
            failed
              ? { type: 'exit', code: 1 }
              : ended.signal !== null
                ? signalExit(ended.signal, watch.sawHeapOom, heapLimitMb(execArgv))
                : { type: 'exit', code: ended.code ?? 0 },
          )
        }
        link.onExit(() => {
          disconnected = true
          report()
        })
        child.once('close', () => {
          stdioClosed = true
          report()
        })
        // A spawn failure has no `exit` event; any later `error` (a send on a closing channel)
        // is reported by the exit that follows it.
        child.on('error', (error) => {
          if (child.pid !== undefined) return
          printError(stderr, error)
          failed = true
          ended = { code: 1, signal: null }
          disconnected = true
          stdioClosed = true
          report()
        })
        child.once('exit', (code, signal) => {
          ended = { code, signal }
          grace = setTimeout(() => {
            disconnected = true
            stdioClosed = true
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
