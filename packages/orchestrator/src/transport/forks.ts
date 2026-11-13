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
import {
  createTransport,
  forwardStdio,
  oomExit,
  printError,
  type TransportOptions,
} from './shared.ts'
import { createStderrWatch, type StderrWatch } from './stderr-watch.ts'

/** How long after a child's exit its IPC channel and stdio may take to close. */
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
   * The child's old-generation heap limit, as `--max-old-space-size` (added after `execArgv`'s
   * flags, so it wins over one they have). A child that goes over it ends with `oom` and this
   * limit. Default: the flags' own, else V8's.
   */
  readonly memoryLimitMb?: number
}

/** The last `--max-old-space-size` among `execArgv` (as V8 reads them), in MB. */
function flaggedHeapLimitMb(execArgv: readonly string[]): number | undefined {
  for (const flag of execArgv.toReversed()) {
    const match = /^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(flag)
    if (match !== null) return Number(match[1])
  }
  return undefined
}

/**
 * How a child that was killed by `signal` ended. V8 aborts (SIGABRT) a process that is out of heap
 * after printing a fatal error, and so does a `process.abort()`; its stderr says which (`sawHeapOom`:
 * the fatal error went by, wherever in the stream). A SIGABRT without that line is `likelyOom`,
 * as before.
 */
function signalExit(
  signal: NodeJS.Signals,
  sawHeapOom: boolean,
  limitMb: number | undefined,
): WorkerExit {
  if (signal === 'SIGABRT' && sawHeapOom) return oomExit(limitMb)
  return { type: 'signal', signal, likelyOom: signal === 'SIGABRT' }
}

/**
 * What `reportChildExit` reads of a child process (a `ChildProcess` is one).
 * @internal
 */
export interface ChildEvents {
  readonly pid?: number | undefined
  once(event: 'close', listener: () => void): unknown
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Reports how a child ended, once. It has ended when it has exited *and* its IPC channel has
 * disconnected, so every message it sent first has arrived. Only a SIGABRT also waits for its stdio
 * to close: that is the one exit read from the last of its stderr (V8's out-of-memory line), and
 * any other must not wait for a test's grandchild that holds the pipe open. A grandchild holding
 * the channel or a pipe open could delay that forever, so after the exit it gets `graceMs`, then
 * is ignored.
 * @internal
 */
export function reportChildExit(
  watched: {
    readonly child: ChildEvents
    readonly link: { onExit(listener: () => void): unknown }
    readonly watch: Pick<StderrWatch, 'sawHeapOom'>
    /** The heap limit the child runs under, or `undefined` for V8's default. */
    readonly limitMb: number | undefined
    /** Where a spawn failure is printed. */
    readonly stderr: NodeJS.WritableStream
    readonly graceMs: number
  },
  listener: (exit: WorkerExit) => void,
): void {
  const { child, link, watch, limitMb, stderr, graceMs } = watched
  let ended: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined
  let disconnected = false
  let stdioClosed = false
  let reported = false
  let grace: NodeJS.Timeout | undefined
  const report = (): void => {
    if (reported || ended === undefined || !disconnected) return
    if (!stdioClosed && ended.signal === 'SIGABRT') return
    reported = true
    clearTimeout(grace)
    listener(
      ended.signal === null
        ? { type: 'exit', code: ended.code ?? 0 }
        : signalExit(ended.signal, watch.sawHeapOom, limitMb),
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
    }, graceMs).unref()
    report()
  })
}

/**
 * Starts each worker in a forked child process.
 * @public
 */
export function forksTransport(options: ForksTransportOptions): TransportFactory {
  const bootstrap = fileURLToPath(import.meta.resolve('@provino/orchestrator/worker/bootstrap'))
  const flags = options.execArgv ?? process.execArgv
  const execArgv =
    options.memoryLimitMb === undefined
      ? [...flags]
      : [...flags, `--max-old-space-size=${options.memoryLimitMb}`]
  const limitMb = options.memoryLimitMb ?? flaggedHeapLimitMb(flags)
  return createTransport('forks', options, (entry) => {
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
      onExit(listener) {
        reportChildExit(
          { child, link, watch, limitMb, stderr, graceMs: DISCONNECT_GRACE_MS },
          listener,
        )
      },
      kill(signal) {
        child.kill(signal)
      },
    }
  })
}
