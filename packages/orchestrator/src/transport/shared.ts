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
  WorkerExit,
  WorkerInit,
  WorkerToCoordinator,
} from '@provino/types'
import { OrchestratorError } from '../errors.ts'

/** Track 9: the wait between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 500

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
  /** Where the worker's own stdout goes (piped with `end: false`). Default: this process's. */
  readonly stdout?: NodeJS.WritableStream
  /** Where the worker's own stderr goes. Default: this process's. */
  readonly stderr?: NodeJS.WritableStream
  /** How long a new worker may take to say `ready`. Default 30 s. */
  readonly startTimeoutMs?: number
  /** How long `terminate(false)` waits after `stop` before SIGTERM. Default 10 s (Track 9). */
  readonly teardownTimeoutMs?: number
}

/** A spawned worker, as one transport kind sees it. */
export interface Spawned {
  readonly link: MessageLink<CoordinatorToWorker, WorkerToCoordinator>
  readonly pid: number | undefined
  /** Called once with the worker's exit, as the kind maps it. */
  onExit(listener: (exit: WorkerExit) => void): void
  /** Ends the worker: SIGTERM asks, SIGKILL forces (a thread or inline worker ends either way). */
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

/** Turns a spawned worker into a `Transport` once it has said `ready`, and sends it `start`. */
export function connect(
  kind: PoolKind,
  spawned: Spawned,
  init: WorkerInit,
  options: TransportOptions,
): Promise<Transport> {
  const startTimeoutMs = options.startTimeoutMs ?? 30_000
  const teardownTimeoutMs = options.teardownTimeoutMs ?? 10_000
  const exitListeners = new Set<(exit: WorkerExit) => void>()
  let exit: WorkerExit | undefined
  /** Set when the transport killed the worker after a timeout, which is then its exit. */
  let timedOut: WorkerExit | undefined
  let resolveExited: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })

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

  return new Promise<Transport>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut ??= { type: 'timeout', phase: 'start' }
      spawned.kill('SIGKILL')
    }, startTimeoutMs)
    const offExit = transport.onExit((workerExit) => {
      clearTimeout(timer)
      offReady()
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
      clearTimeout(timer)
      offReady()
      offExit()
      spawned.link.send({ t: 'start', init })
      resolve(transport)
    })
  })
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

/** Whether `promise` settles within `ms`. The timer never keeps the process alive. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    timer.unref()
  })
  try {
    return await Promise.race([promise.then(() => true as const), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** The entry as a URL string, which `import()`, `fork` arguments and `workerData` all carry. */
export function entryHref(entry: string | URL): string {
  if (entry instanceof URL) return entry.href
  return entry.startsWith('file:') ? entry : pathToFileURL(entry).href
}
