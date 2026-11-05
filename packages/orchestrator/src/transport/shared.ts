// What every transport kind shares: the `ready` → `start` handshake, one exit report, and
// Track 9's shutdown (`stop`, the teardown timeout, SIGTERM, then SIGKILL after 500 ms). A kind
// supplies only how to spawn, what its exit looks like, and how to kill it.
import { clearTimeout, setTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'
import type {
  CoordinatorToWorker,
  MessageLink,
  PoolKind,
  Transport,
  TransportFactory,
  WorkerExit,
  WorkerInit,
  WorkerToCoordinator,
} from '@provino/types'
import { OrchestratorError } from '../errors.ts'
import { messageOf } from '../util.ts'

/** Track 9: the wait between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 500

/** Track 9: how long `terminate(false)` waits after `stop` before SIGTERM. */
const DEFAULT_TEARDOWN_TIMEOUT_MS = 10_000

/** `options.teardownTimeoutMs`, or Track 9's default. */
export function teardownTimeoutOf(options: TransportOptions): number {
  return options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS
}

/**
 * Options every transport kind takes.
 * @public
 */
export interface TransportOptions {
  /**
   * The worker main module, as a `file:` URL or an absolute path. Its default export is a
   * `WorkerMain`.
   */
  readonly entry: string | URL
  /** Where the worker's own stdout goes (copied; the sink is never ended). Default: this process's. */
  readonly stdout?: NodeJS.WritableStream
  /** Where the worker's own stderr goes. Default: this process's. */
  readonly stderr?: NodeJS.WritableStream
  /** How long a new worker may take to say `ready`. Default 30 s. */
  readonly startTimeoutMs?: number
  /**
   * How long `terminate(false)` waits after `stop` before SIGTERM. Default 10 s (Track 9). An
   * inline transport also waits this long, once its link has closed, for the worker's `main` to
   * settle before it reports the exit.
   */
  readonly teardownTimeoutMs?: number
}

/** A spawned worker, as one transport kind sees it. */
export interface Spawned {
  readonly link: MessageLink<CoordinatorToWorker, WorkerToCoordinator>
  readonly pid: number | undefined
  /** Called once, right after spawning, with the listener for the worker's exit as the kind maps it. */
  onExit(listener: (exit: WorkerExit) => void): void
  /** Ends the worker: SIGTERM asks, SIGKILL forces. A thread ends either way; an inline worker only loses its link. */
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

/**
 * A transport kind: `spawn` starts one worker for the entry module (its URL); the rest (the
 * handshake, exits, shutdown) is shared.
 */
export function createTransport(
  kind: PoolKind,
  options: TransportOptions,
  spawn: (entry: string) => Spawned | Promise<Spawned>,
): TransportFactory {
  const entry = entryHref(options.entry)
  return {
    kind,
    create: async (init, signal) => {
      signal?.throwIfAborted()
      return await connect(kind, await spawn(entry), init, options, signal)
    },
  }
}

/** Turns a spawned worker into a `Transport` once it has said `ready`, and sends it `start`. */
export function connect(
  kind: PoolKind,
  spawned: Spawned,
  init: WorkerInit,
  options: TransportOptions,
  signal?: AbortSignal,
): Promise<Transport> {
  const teardownTimeoutMs = teardownTimeoutOf(options)
  const exitListeners = new Set<(exit: WorkerExit) => void>()
  let exit: WorkerExit | undefined
  /** Set when the transport killed the worker after a timeout, which is then its exit. */
  let timedOut: WorkerExit | undefined
  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<void>()

  spawned.onExit((raw) => {
    if (exit !== undefined) return
    exit = timedOut ?? raw
    for (const listener of exitListeners) listener(exit)
    exitListeners.clear()
    spawned.link.close()
    resolveExited()
  })

  const transport: Transport = {
    kind,
    pid: spawned.pid,
    send(message, transfer) {
      spawned.link.send(message, transfer)
    },
    onMessage(listener) {
      return spawned.link.onMessage(listener)
    },
    onExit(listener) {
      if (exit !== undefined) {
        listener(exit)
        return () => {}
      }
      exitListeners.add(listener)
      return () => {
        exitListeners.delete(listener)
      }
    },
    async terminate(force) {
      if (exit !== undefined) return
      if (force) {
        spawned.kill('SIGKILL')
        return await exited
      }
      spawned.link.send({ t: 'stop' })
      if (await settlesWithin(exited, teardownTimeoutMs)) return
      timedOut ??= { type: 'timeout', phase: 'stop' }
      spawned.kill('SIGTERM')
      if (await settlesWithin(exited, KILL_GRACE_MS)) return
      spawned.kill('SIGKILL')
      return await exited
    },
  }

  return handshake(
    kind,
    spawned,
    transport,
    init,
    options.startTimeoutMs ?? 30_000,
    () => {
      timedOut ??= { type: 'timeout', phase: 'start' }
    },
    signal,
  )
}

/**
 * Waits for `ready`, sends `start`, and resolves with the transport. Its own function, so the
 * long-lived transport doesn't keep `init` (the project config) reachable. The start send is the
 * one check that `init` can cross: a value the link can't write kills the worker and rejects
 * with `ORCH_BAD_INIT`.
 */
function handshake(
  kind: PoolKind,
  spawned: Spawned,
  transport: Transport,
  init: WorkerInit,
  startTimeoutMs: number,
  markTimedOut: () => void,
  signal: AbortSignal | undefined,
): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      offReady()
      offExit()
    }
    // Aborted while starting: the worker is killed at once and its exit rejects, as any early one.
    const onAbort = (): void => {
      clearTimeout(timer)
      offReady()
      spawned.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      // A `ready` read after this is too late: the worker is being killed, and its exit rejects
      // with the timeout.
      offReady()
      markTimedOut()
      spawned.kill('SIGKILL')
    }, startTimeoutMs)
    const offExit = transport.onExit((workerExit) => {
      done()
      reject(
        workerExit.type === 'timeout'
          ? new OrchestratorError(
              'ORCH_WORKER_START_TIMEOUT',
              `The ${kind} worker didn't start within ${startTimeoutMs} ms`,
              { cause: workerExit },
            )
          : new OrchestratorError(
              'ORCH_WORKER_EXITED',
              `The ${kind} worker exited before it started (${describeExit(workerExit)})`,
              { cause: workerExit },
            ),
      )
    })
    const offReady = spawned.link.onMessage((message) => {
      if (message.t !== 'ready') return
      done()
      try {
        spawned.link.send({ t: 'start', init })
      } catch (error) {
        spawned.kill('SIGKILL')
        reject(badInit(kind, error))
        return
      }
      resolve(transport)
    })
    if (signal?.aborted === true) onAbort()
  })
}

function badInit(kind: PoolKind, error: unknown): OrchestratorError {
  return new OrchestratorError(
    'ORCH_BAD_INIT',
    `The ${kind} worker's init can't be sent to it: ${messageOf(error)}`,
    { cause: error },
  )
}

/**
 * Copies a worker's own stdout and stderr into the sinks (default: this process's), and returns
 * the stderr sink.
 */
export function forwardStdio(
  worker: {
    readonly stdout: NodeJS.ReadableStream | null
    readonly stderr: NodeJS.ReadableStream | null
  },
  options: TransportOptions,
): NodeJS.WritableStream {
  const stderr = options.stderr ?? process.stderr
  forward(worker.stdout, options.stdout ?? process.stdout)
  forward(worker.stderr, stderr)
  return stderr
}

/**
 * Copies a worker's own stdout or stderr into `sink`, chunk by chunk. Not `pipe`: every pipe into
 * one shared sink (this process's stdout) adds four listeners to it, and a dozen workers would set
 * off `MaxListenersExceededWarning`. The sink is never ended.
 */
function forward(source: NodeJS.ReadableStream | null, sink: NodeJS.WritableStream): void {
  source?.on('data', (chunk: Buffer) => {
    sink.write(chunk)
  })
}

/** Writes a worker's error that nothing else would show (a thread's uncaught one, a spawn failure). */
export function printError(sink: NodeJS.WritableStream, error: unknown): void {
  sink.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
}

/**
 * A worker's exit in words, for error messages.
 * @public
 */
export function describeExit(exit: WorkerExit): string {
  switch (exit.type) {
    case 'signal':
      return `killed by ${exit.signal}${exit.likelyOom ? ', likely out of memory' : ''}`
    case 'exit':
      return `exit code ${exit.code}`
    case 'oom':
      return `out of memory at its ${exit.limitMb} MB limit`
    case 'timeout':
      return `timed out during ${exit.phase}`
    default:
      return exit satisfies never
  }
}

/**
 * Whether `promise` settles within `ms`. By default the timer doesn't keep the process alive: a
 * fork or thread being waited for holds a handle of its own. Pass `ref: true` when nothing else
 * may: an inline worker stuck on a promise holds no handle, and an unref'd bound would let the
 * event loop drain with the wait still pending.
 */
export async function settlesWithin(
  promise: Promise<void>,
  ms: number,
  options: { readonly ref?: boolean } = {},
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    if (options.ref !== true) timer.unref()
  })
  try {
    return await Promise.race([promise.then(() => true as const), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** The entry as a URL string, which `import()`, `fork` arguments and `workerData` all carry. */
function entryHref(entry: string | URL): string {
  if (entry instanceof URL) return entry.href
  return entry.startsWith('file:') ? entry : pathToFileURL(entry).href
}
