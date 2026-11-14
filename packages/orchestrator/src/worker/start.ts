// The worker's side of the protocol (Track 9 §Wire protocol): `ready`, then `start`, then one
// `run` at a time. After each file it lets pending microtasks finish, flushes stdio (Vitest found
// it is otherwise lost on terminate), and queues `fileDone` behind the file's packs, so the file's
// events and output always arrive first. The runtime that actually runs a file is the runner's
// (U1, B10); this file knows nothing about tests. On `stop` it lets the runner tear down, then
// sends `stopped`.
import { getHeapStatistics } from 'node:v8'
import { isMainThread } from 'node:worker_threads'
import { createRpc, type RpcOptions, serializeError } from '@provino/rpc'
import type {
  CoordinatorMethods,
  FileJob,
  RpcClient,
  SerializedError,
  SnapshotFileReport,
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
import { flushStdio } from './stdio.ts'
import { nextMacrotask } from './timers.ts'

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
  /**
   * Global keys the file left behind that its environment could not remove (decision D22), as
   * strings. They go out as `fileDone.leakedGlobals`, so the pool can recycle the worker. Absent
   * or empty for a clean file. The runner sends the matching `console` warning itself.
   */
  readonly leakedGlobals?: readonly string[]
  /**
   * What the file's snapshot state ended with (the `.snap` is already written). It goes out as
   * `fileDone.snapshot`; the coordinator adds the files up. Absent for a runner that keeps no
   * snapshot state, or a file that never collected its tests.
   */
  readonly snapshot?: SnapshotFileReport
  /**
   * The modules the file loaded (absolute paths: its setup files, the test file and what they
   * import), as the loader reports them. They go out as one `deps` event before `fileDone`, for
   * affected-test selection (T9.12). Absent for a runner with no loader.
   */
  readonly deps?: readonly string[]
}

/**
 * Runs test files in a worker. B10 supplies the real one (loader → core → expect).
 * @beta
 */
export interface WorkerRunner {
  start?(context: WorkerContext): void | Promise<void>
  runFile(context: FileContext): Promise<FileOutcome | undefined>
  /**
   * Tears down what `start` and the files left: called once, on the coordinator's `stop`, after
   * every queued file has finished and before `stopped` is sent. It runs even when `start`
   * threw, so it must cope with a half-built worker. It is not called if `start` never came.
   * What it throws is reported as an unhandled error with no owner, and `stopped` is sent anyway.
   * One that never settles holds `stopped` back until the coordinator's stop timeout kills the
   * worker.
   *
   * It is also called, best-effort, when the link goes away before any `stop` came (the
   * coordinator was killed, or `terminate(true)` closed the link of an inline worker, which
   * shares this process with the next one): without it the matcher slot, the loader and the
   * environment would stay installed. Nothing can be sent then, so what it throws or emits is
   * dropped. It queues behind the file running now, so a file that is still running delays it:
   * `cancel` can't reach core until T5.12, so such a file runs to its end. The promise
   * `startWorker` returns settles only after this stop has, so whoever awaits the worker's main
   * (the inline transport) knows the teardown is over.
   */
  stop?(context: WorkerContext): void | Promise<void>
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
 * worker has stopped, or the coordinator has gone away and the runner's best-effort `stop` (see
 * `WorkerRunner.stop`) has settled.
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
    // The policy arrives with `init`, after the capture is made.
    origin: () => init?.config.policy.orchestrator.consoleOrigin === 'stack',
  })
  let init: WorkerInit | undefined
  let installed: InstalledCapture | undefined
  let finished = false
  /** Set when a `stop` arrives, or when the link's exit queued the best-effort one: `runner.stop` runs once. */
  let stopQueued = false
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>()
  /** Settles once `runner.stop` has (or there was none to call): the link going away waits for it. */
  const { promise: runnerStopped, resolve: resolveRunnerStopped } = Promise.withResolvers<void>()
  /** Work in arrival order: start, each run, stop. A failed step never blocks the next. */
  let queue: Promise<void> = Promise.resolve()
  /** Set when `runner.start` threw: every file is then charged with that error, unrun. */
  let startFailure: { readonly error: unknown } | undefined
  /** One controller per file received and not finished: a `cancel` aborts them all. */
  const controllers = new Map<number, AbortController>()
  /** The id of each module path this worker has sent in a `deps` event (the coordinator keeps the same table). */
  const interned = new Map<string, number>()

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

  const abortAll = (reason: Error): void => {
    for (const controller of controllers.values()) controller.abort(reason)
  }

  /** Nothing is left to report to: aborts every file, keeps queued ones from starting, restores the console. */
  const finish = (): void => {
    if (finished) return
    finished = true
    abortAll(new Error('The coordinator went away'))
    installed?.restore()
    installed = undefined
  }

  /**
   * Calls `runner.stop` if the worker started, once, and gives `onError` what it throws. Never
   * throws itself.
   */
  const stopRunner = async (onError: (error: unknown) => void): Promise<void> => {
    try {
      if (init !== undefined) await runner.stop?.(context())
    } catch (error) {
      onError(error)
    } finally {
      resolveRunnerStopped()
    }
  }

  /**
   * Lets the microtasks the file left behind run (a floating `.then` that still logs), and flushes
   * stdio, so `afterSent` then queues behind everything the file wrote.
   */
  const settle = async (): Promise<void> => {
    await nextMacrotask()
    await (installed === undefined ? flushStdio() : installed.flush())
  }

  /** Reports an error the runner didn't, as an unhandled error charged to `ownerId`. Never throws. */
  const charge = (error: unknown, ownerId: TaskId | null): void => {
    let serialized: SerializedError
    try {
      serialized = (options.serializeError ?? serializeError)(error)
    } catch {
      serialized = serializeError(error)
    }
    packer.emit({
      type: 'unhandled-error',
      ownerId,
      lastTestId: null,
      origin: 'uncaughtException',
      error: serialized,
      t: performance.now(),
    })
  }

  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((error: unknown) => charge(error, null))
  }

  const runOne = async (seq: number, job: FileJob): Promise<void> => {
    const controller = controllers.get(seq)
    // The coordinator is gone: a queued file never starts.
    if (finished || controller === undefined) return
    // Each file gets a fresh console: an open group, a count or a timer stays with its file.
    capture.reset()
    let leakedHandles = 0
    let leakedGlobals: readonly string[] = []
    let snapshot: SnapshotFileReport | null = null
    try {
      if (startFailure !== undefined) throw startFailure.error
      const outcome = await runner.runFile({ ...context(), job, signal: controller.signal })
      leakedHandles = outcome?.leakedHandles ?? 0
      leakedGlobals = outcome?.leakedGlobals ?? []
      snapshot = outcome?.snapshot ?? null
      if (outcome?.deps !== undefined) {
        // Each path crosses the link once per worker; after that it is its id.
        const added: string[] = []
        const ids: number[] = []
        for (const path of outcome.deps) {
          let id = interned.get(path)
          if (id === undefined) {
            id = interned.size
            interned.set(path, id)
            added.push(path)
          }
          ids.push(id)
        }
        packer.emit({ type: 'deps', fileId: job.fileId, added, ids, t: performance.now() })
      }
    } catch (error) {
      // The runtime reports test failures as events; a runner that throws is a bug, charged to the file.
      charge(error, job.fileId)
    } finally {
      controllers.delete(seq)
    }
    await settle()
    const memoryBytes = measureMemory(init)
    packer.afterSent(() =>
      port.send({
        t: 'fileDone',
        seq,
        memoryBytes,
        leakedHandles,
        leakedGlobals,
        ...(snapshot === null ? {} : { snapshot }),
      }),
    )
  }

  port.onExit(() => {
    // The link went away: files are aborted and the console is given back at once, and nothing can
    // be sent now. But an inline worker lives in the coordinator's process, so the slot, the loader
    // and the environment it installed must not outlive it (the next worker would find the matcher
    // slot taken): without a `stop` of its own the runner gets a best-effort one, and `done` waits
    // for it, because that is when this worker has ended. Errors have nowhere to go.
    finish()
    if (!stopQueued) {
      stopQueued = true
      enqueue(() => stopRunner(() => {}))
    }
    void runnerStopped.then(resolveDone)
  })
  port.onMessage((message) => {
    switch (message.t) {
      case 'start': {
        init = message.init
        // A run in band captures `console` only: the streams are the coordinator's own, and the
        // reporters write to them.
        const inBand = init.captureConsole === true
        const streams = options.console?.streams ?? (inBand ? discardedStreams() : undefined)
        const global = options.console?.global ?? (inBand || init.key.pool !== 'inline')
        if (streams !== undefined || global) {
          installed = capture.install(
            streams ?? { stdout: process.stdout, stderr: process.stderr },
            global ? (globalThis as { console: Console }) : undefined,
          )
        }
        enqueue(async () => {
          try {
            await runner.start?.(context())
          } catch (error) {
            startFailure = { error }
          }
        })
        return
      }
      case 'run':
        controllers.set(message.seq, new AbortController())
        enqueue(() => runOne(message.seq, message.job))
        return
      case 'ack':
        packer.ack(message.pack)
        return
      case 'cancel':
        // It covers the running file and every file already queued; later runs are new work.
        abortAll(new Error(`Cancelled: ${message.reason}`))
        return
      case 'stop':
        stopQueued = true
        enqueue(async () => {
          // The queue has drained: every file received before `stop` has sent its `fileDone`.
          // `stopped` is how the coordinator knows the worker ended cleanly; a failed teardown is
          // news for the run, not a reason to withhold it.
          await stopRunner((error) => charge(error, null))
          await settle()
          const { promise: stopped, resolve } = Promise.withResolvers<void>()
          packer.afterSent(() => {
            port.send({ t: 'stopped' })
            resolve()
          })
          await stopped
          port.close()
          finish()
          resolveDone()
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
 * RSS in a fork, where the process is the worker's own. In a thread or inline RSS is the whole
 * process's, and `external` and `arrayBuffers` are no better: they count what the isolate has
 * reserved, not what it holds (oxc-parser's raw transfer buffer is a 6 GiB `ArrayBuffer` of
 * virtual memory, so a thread with a RSS of 150 MB reads about 6.4 GB of `external`). So the
 * thread's own isolate heap, `used_heap_size`: what jest-worker reads as
 * `process.memoryUsage().heapUsed` in a thread or a child.
 */
function measureMemory(init: WorkerInit | undefined): number {
  const pool = init?.key.pool ?? (isMainThread ? 'forks' : 'threads')
  if (pool === 'forks') return process.memoryUsage.rss()
  return getHeapStatistics().used_heap_size
}

/** Stand-ins for stdout and stderr that nothing writes to: the capture patches them and no more. */
function discardedStreams(): { readonly stdout: WritableLike; readonly stderr: WritableLike } {
  // `writableLength` 0 is what lets the capture's flush finish without waiting for a callback.
  const stream = (): WritableLike =>
    ({ writableLength: 0, write: () => true }) as unknown as WritableLike
  return { stdout: stream(), stderr: stream() }
}
