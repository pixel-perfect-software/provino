// The worker's side of the protocol (Track 9 §Wire protocol): `ready`, then `start`, then one
// `run` at a time. After each file it flushes the packer, then empty writes on stdout and stderr
// (Vitest found stdio is otherwise lost on terminate), and only then sends `fileDone`, so the file's
// events and output always arrive first. The runtime that actually runs a file is the runner's
// (U1, B10); this file knows nothing about tests.
import { isMainThread } from 'node:worker_threads'
import { createRpc, type RpcOptions } from '@provino/rpc'
import type {
  CoordinatorMethods,
  FileJob,
  RpcClient,
  SerializedError,
  TaskId,
  WorkerInit,
  WorkerMethods,
  WorkerPort,
} from '@provino/types'
import {
  type ConsoleCapture,
  createConsoleCapture,
  type InstalledCapture,
  type WritableLike,
} from './console.ts'
import { createPacker, type Packer, type PackerOptions } from './packer.ts'

/**
 * What a worker's runner sees once the worker has started.
 * @beta
 */
export interface WorkerContext {
  readonly init: WorkerInit
  /** Calls into the coordinator. */
  readonly coordinator: RpcClient<CoordinatorMethods>
  /** Where the runtime sends its events: the packer, an `EventSink`. */
  readonly sink: Packer
  /** The capture's console, to install as a test file's `console`. */
  readonly console: ConsoleCapture['console']
}

/**
 * What a runner sees while it runs one file.
 * @beta
 */
export interface FileContext extends WorkerContext {
  readonly job: FileJob
  /** Aborted when the coordinator sends `cancel`, or the coordinator goes away. */
  readonly signal: AbortSignal
}

/**
 * What a runner reports about a finished file.
 * @beta
 */
export interface FileOutcome {
  /** Handles still open after the file's teardown (Track 2's leak detector). */
  readonly leakedHandles?: number
}

/**
 * Runs test files in a worker. B10 supplies the real one (loader → core → expect).
 * @beta
 */
export interface WorkerRunner {
  start?(context: WorkerContext): void | Promise<void>
  runFile(context: FileContext): Promise<FileOutcome | undefined>
}

/**
 * Options for `startWorker`.
 * @beta
 */
export interface StartWorkerOptions {
  readonly packer?: PackerOptions
  readonly console?: {
    /** The task running now, for console attribution. Default: always `null`. */
    readonly currentTaskId?: () => TaskId | null
    /**
     * Patch `globalThis.console` and `process.stdout`/`stderr`. Default: on, except for an inline
     * worker, which shares them with the coordinator.
     */
    readonly global?: boolean
    /** Streams to patch instead of `process.stdout`/`stderr`. */
    readonly streams?: { readonly stdout: WritableLike; readonly stderr: WritableLike }
  }
  /** Serializes an RPC handler's error. Default: `@provino/rpc`'s. */
  readonly serializeError?: (error: unknown) => SerializedError
}

/**
 * Speaks the worker side of the protocol on `port`, running files with `runner`. Resolves once the
 * worker has stopped or the coordinator has gone away.
 * @beta
 */
export function startWorker(
  port: WorkerPort,
  runner: WorkerRunner,
  options: StartWorkerOptions = {},
): Promise<void> {
  const packer = createPacker((message) => port.send(message), options.packer)
  const capture = createConsoleCapture({
    emit: (event) => packer.emit(event),
    currentTaskId: options.console?.currentTaskId ?? (() => null),
  })
  let init: WorkerInit | undefined
  let installed: InstalledCapture | undefined
  let current: AbortController | undefined
  let finished = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  /** Work in arrival order: start, each run, stop. */
  let queue: Promise<void> = Promise.resolve()

  const rpcOptions: RpcOptions =
    options.serializeError === undefined ? {} : { serializeError: options.serializeError }
  const coordinator = createRpc<WorkerMethods, CoordinatorMethods>(
    port,
    { memoryUsage: () => measureMemory(init) },
    rpcOptions,
  )

  const context = (): WorkerContext => ({
    init: init as WorkerInit,
    coordinator,
    sink: packer,
    console: capture.console,
  })

  const finish = (): void => {
    if (finished) return
    finished = true
    current?.abort(new Error('The coordinator went away'))
    installed?.restore()
    installed = undefined
    resolveDone()
  }

  const flushStdio = async (): Promise<void> => {
    if (installed !== undefined) return await installed.flush()
    await Promise.all([writeEmpty(process.stdout), writeEmpty(process.stderr)])
  }

  const runOne = async (seq: number, job: FileJob): Promise<void> => {
    const controller = new AbortController()
    current = controller
    let leakedHandles = 0
    try {
      const outcome = await runner.runFile({ ...context(), job, signal: controller.signal })
      leakedHandles = outcome?.leakedHandles ?? 0
    } catch (error) {
      // The runtime reports test failures as events; a runner that throws is a bug, charged to the file.
      packer.emit({
        type: 'unhandled-error',
        ownerId: job.fileId,
        lastTestId: null,
        origin: 'uncaughtException',
        error: (options.serializeError ?? describeError)(error),
        t: performance.now(),
      })
    } finally {
      current = undefined
    }
    await packer.flush()
    await flushStdio()
    if (!finished)
      port.send({ t: 'fileDone', seq, memoryBytes: measureMemory(init), leakedHandles })
  }

  port.onExit(finish)
  port.onMessage((message) => {
    switch (message.t) {
      case 'start': {
        init = message.init
        const streams = options.console?.streams
        const global = options.console?.global ?? init.key.pool !== 'inline'
        if (streams !== undefined || global) {
          installed = capture.install(
            streams ?? { stdout: process.stdout, stderr: process.stderr },
            global ? (globalThis as { console: Console }) : undefined,
          )
        }
        queue = queue.then(() => runner.start?.(context()))
        return
      }
      case 'run':
        queue = queue.then(() => runOne(message.seq, message.job))
        return
      case 'ack':
        packer.ack(message.pack)
        return
      case 'cancel':
        current?.abort(new Error(`Cancelled: ${message.reason}`))
        return
      case 'stop':
        queue = queue.then(async () => {
          await packer.flush()
          await flushStdio()
          installed?.restore()
          installed = undefined
          port.send({ t: 'stopped' })
          port.close()
          finish()
        })
        return
      case 'call':
      case 'reply':
        return // the RPC layer's
      default:
        return message satisfies never
    }
  })
  port.send({ t: 'ready' })
  return done
}

/**
 * RSS in a fork; `heapUsed + external` in a thread or inline, where RSS is the whole process's.
 */
function measureMemory(init: WorkerInit | undefined): number {
  const pool = init?.key.pool ?? (isMainThread ? 'forks' : 'threads')
  if (pool === 'forks') return process.memoryUsage.rss()
  const { heapUsed, external } = process.memoryUsage()
  return heapUsed + external
}

/** A thrown value as a `SerializedError`, when no serializer was given. */
function describeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  }
}

function writeEmpty(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve())
  })
}
