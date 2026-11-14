// T9.11's engine (B23c Phase 7): a watch session. It keeps, for as long as it lives, one pool
// (speed: never drained between runs, where Jest starts a worker farm for each), the results and
// transform caches, the affected index of each project, and the file watcher. Each `run` goes
// through `runProjectsOn` with the session's pool bound to it; what changed since a worker's last
// file goes with its next one (`stale.ts`). Which files a run selects, and when one starts, is the
// caller's: Jest's driver lives in `@provino/dialect-jest/node` and reaches this through `provino`.
import { basename, resolve, sep } from 'node:path'
import { serialize } from 'node:v8'
import type { ResolvedProject } from '@provino/config'
import type { PoolKind, RunSummary, Transport, TransportFactory, WorkerEvent } from '@provino/types'
import { type AffectedIndex, createAffectedIndex } from '../affected/index.ts'
import { openRecordedGraph, type RecordedGraph } from '../affected/recorded.ts'
import { cacheDirectories, type ResultsCache } from '../cache.ts'
import type { DepsTable } from '../deps-table.ts'
import { crawlProject } from '../discover-rules.ts'
import { OrchestratorError } from '../errors.ts'
import { createPool, type Pool, type PoolOutcome } from '../pool.ts'
import {
  poolSettings,
  type RunHost,
  type RunPoolDeps,
  type RunProjectOptions,
  runProjectsOn,
} from '../run.ts'
import { messageOf } from '../util.ts'
import { type CoalesceClock, createCoalescer, type WatchEvent } from './coalesce.ts'
import { createStaleModules, retirementFor } from './stale.ts'
import { createWatcher } from './watcher.ts'

/**
 * Where a session's changes come from: the file watcher by default, or whatever a caller (a test)
 * feeds `sink`. It returns something to close.
 * @beta
 */
export type ChangeSource = (sink: {
  readonly event: (event: WatchEvent) => void
  readonly error: (error: unknown) => void
}) => Promise<{ close(): void }> | { close(): void }

/**
 * The run options a session fixes for every run: the pool, the caches, where output goes, the
 * worker entry and the run's own hooks.
 * @beta
 */
export type WatchSessionRunSettings = Pick<
  RunProjectOptions,
  | 'pool'
  | 'cache'
  | 'env'
  | 'cwd'
  | 'stdout'
  | 'stderr'
  | 'entry'
  | 'root'
  | 'globalSetup'
  | 'forceSignal'
  | 'runInBand'
>

/**
 * What a watch session is made with.
 * @beta
 */
export interface WatchSessionOptions extends WatchSessionRunSettings {
  /** Where changes come from. Default: a watcher (`createWatcher`) over every project's roots. */
  readonly changes?: ChangeSource
  /**
   * Whether a changed path counts (Jest's `isValidPath`: no `.snap` and nothing under the coverage
   * directory, so a run's own writes don't start another). Default: every path the crawl keeps.
   */
  readonly isRelevant?: (path: string) => boolean
  /** Regular expression sources the watcher and the affected index leave out (`watchPathIgnorePatterns`). */
  readonly ignorePatterns?: readonly string[]
  /** One watch per directory (Linux's way, its default) rather than one recursive watch per root. */
  readonly perDirectory?: boolean
  /** The coalescing window's timers. Default: the real ones. */
  readonly clock?: CoalesceClock
  /** A change source that fails. Default: a line on `stderr`. */
  readonly onError?: (error: unknown) => void
}

/**
 * One run of a session: `RunProjectOptions` without what the session fixes. `signal` is the
 * session's own (`interrupt`), and `detectOpenHandles` needs every worker stopped after the run,
 * which a session never does.
 * @beta
 */
export type WatchRunOptions = Omit<
  RunProjectOptions,
  keyof WatchSessionRunSettings | 'signal' | 'detectOpenHandles'
>

/**
 * A watch session.
 * @beta
 */
export interface WatchSession {
  /**
   * Runs the projects once on the session's pool, after every change seen so far is applied to the
   * affected indexes. One run at a time: a second while one runs is `ORCH_BAD_OPTION`.
   */
  run(options: WatchRunOptions): Promise<RunSummary>
  /**
   * Ends the run that is going (a key pressed during a run): no file starts, the running ones are
   * killed and reported `Interrupted`, and the run ends `interrupted`. The idle workers stay.
   */
  interrupt(): void
  /** Whether a run is going. */
  readonly running: boolean
  /**
   * Calls `listener` with each batch of changes (after the coalescing window), once the workers
   * have been told of it. Returns the unsubscribe.
   */
  onChange(listener: (batch: readonly WatchEvent[]) => void): () => void
  /** Stops watching, interrupts a run, stops every worker and resolves once all have exited. */
  close(): Promise<void>
}

/**
 * Starts a watch session over `projects`: the pool and the change source are made now (the
 * watcher walks the roots), no worker starts until a run asks for one.
 * @beta
 */
export async function createWatchSession(
  projects: readonly ResolvedProject[],
  options: WatchSessionOptions = {},
): Promise<WatchSession> {
  const [first] = projects
  if (first === undefined) {
    throw new OrchestratorError('ORCH_NO_PROJECTS', 'A watch session needs at least one project.')
  }
  const stderr = options.stderr ?? process.stderr
  /** A change source's failure, or anything else of the session's own; never throws. */
  const reportError = (error: unknown): void => {
    try {
      if (options.onError !== undefined) {
        options.onError(error)
        return
      }
    } catch (handlerError) {
      stderr.write(`Provino: the watch session's onError failed: ${messageOf(handlerError)}\n`)
    }
    stderr.write(`Provino: watch mode: ${messageOf(error)}\n`)
  }
  const inBand = options.runInBand === true
  const kind: PoolKind = inBand
    ? 'inline'
    : (options.pool?.kind ?? first.policy.orchestrator.pool.default)
  const { factory, poolOptions } = poolSettings(options, kind)
  const stale = createStaleModules()
  const depsTables = new Map<number, DepsTable>()

  // Every worker the pool starts hears of each change from the moment it starts, until it exits.
  const tracked: TransportFactory = {
    ...factory,
    async create(init, signal): Promise<Transport> {
      stale.register(init.workerId)
      try {
        const transport = await factory.create(init, signal)
        transport.onExit(() => {
          stale.forget(init.workerId)
          depsTables.delete(init.workerId)
        })
        return transport
      } catch (error) {
        stale.forget(init.workerId)
        throw error
      }
    },
  }

  /** The run the pool serves now: its callbacks, until it ends. */
  let current: RunPoolDeps | undefined
  /**
   * The workers that were alive when the current run began and have not taken one of its files: what
   * they send while they stop (a retirement during this run) is an earlier run's, not this one's.
   */
  const inherited = new Set<number>()
  /** What a worker no run owns sends: its errors are lines on stderr, the rest is dropped. */
  function betweenRuns(events: readonly WorkerEvent[]): void {
    for (const event of events) {
      if (event.type === 'unhandled-error') stderr.write(`Provino: ${event.error.message}\n`)
    }
  }
  const pool = createPool(poolOptions, {
    transport: () => tracked,
    init: (key, workerId) => {
      if (current === undefined) {
        throw new OrchestratorError('ORCH_BAD_OPTION', 'A worker was asked for between runs.')
      }
      return current.init(key, workerId)
    },
    methods: { readTimings: (file) => current?.methods.readTimings(file) },
    onIdleEvents: (workerId, events) => {
      if (current === undefined || inherited.has(workerId)) betweenRuns(events)
      else return current.onIdleEvents?.(workerId, events)
    },
    onError: (error, errorKind, workerId) => {
      const owned = workerId === undefined || !inherited.has(workerId)
      if (owned && current?.onError !== undefined) current.onError(error, errorKind)
      else stderr.write(`Provino: ${messageOf(error)}\n`)
    },
    ...(options.forceSignal === undefined ? {} : { forceSignal: options.forceSignal }),
  })

  /** Binds the session's pool to one run; what the run does to it ends with the run. */
  function attach(deps: RunPoolDeps): Pool {
    current = deps
    inherited.clear()
    for (const workerId of stale.workers()) inherited.add(workerId)
    // A key whose starts failed in an earlier run is tried again in this one.
    pool.resetFailures()
    let done = false
    const { signal } = deps
    const interruptRun = (): void => pool.interrupt()
    signal?.addEventListener('abort', interruptRun, { once: true })
    const detach = (): void => {
      done = true
      signal?.removeEventListener('abort', interruptRun)
      if (current === deps) current = undefined
    }
    const aborted: PoolOutcome = { type: 'aborted' }
    return {
      run: (request) =>
        done || signal?.aborted === true ? Promise.resolve(aborted) : pool.run(request),
      drain: () => {},
      cancelQueued: () => {
        done = true
        pool.interrupt({ keepRunning: true })
      },
      close: () => {
        // Nothing of this run is left running after a normal end; after a bail or a throw, its
        // running files are killed. The workers that are idle stay for the next run.
        pool.interrupt()
        detach()
        return Promise.resolve()
      },
      interrupt: (interruptOptions) => pool.interrupt(interruptOptions),
      retire: (which) => pool.retire(which),
      resetFailures: () => pool.resetFailures(),
    }
  }

  // What every run must see the same: the seed a warm worker booted with, the caches.
  const seed = Math.floor(0x1_0000_0000 * Math.random()) - 0x8000_0000
  const caches = new Map<string, ResultsCache>()
  const lockfileHashes = new Map<string, string>()
  const graphs = new Map<string, Promise<RecordedGraph>>()
  /** Each project's affected index (and the loader its edges resolve through), made on first use. */
  const indexes = new Map<
    number,
    Promise<{ readonly index: AffectedIndex; readonly loader: Disposable }>
  >()
  /** The changes applied to the indexes so far: a run waits for them. */
  let applied: Promise<void> = Promise.resolve()
  /** Runs `work` after every index update and lookup before it: one at a time, never rejecting the chain. */
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = applied.then(work)
    applied = next.then(
      () => {},
      () => {},
    )
    return next
  }
  /** The global setup's `provided` the workers alive now booted with. */
  let provided: Buffer | undefined

  function indexOf(
    projectIndex: number,
    cacheProject: string,
    recorded: RecordedGraph | undefined,
  ): Promise<{ readonly index: AffectedIndex; readonly loader: Disposable }> {
    let made = indexes.get(projectIndex)
    if (made === undefined) {
      const project = projects[projectIndex]
      if (project === undefined) throw new Error(`no project at ${projectIndex}`)
      const making = (async () => {
        const { createCoordinatorLoader } = await import('@provino/loader')
        const loader = await createCoordinatorLoader(
          project.rootDir,
          project.config.loader,
          project.policy.module,
        )
        try {
          const index = await createAffectedIndex(project, {
            cacheDir: options.cache === false ? null : cacheDirectories(project).results,
            projectKey: cacheProject,
            loader,
            ...(recorded === undefined ? {} : { recorded }),
            ...(options.ignorePatterns === undefined
              ? {}
              : { ignorePatterns: options.ignorePatterns }),
          })
          return { index, loader }
        } catch (error) {
          loader[Symbol.dispose]()
          throw error
        }
      })()
      // An index that couldn't be made is made again on its next use.
      making.catch(() => {
        if (indexes.get(projectIndex) === making) indexes.delete(projectIndex)
      })
      made = making
      indexes.set(projectIndex, made)
    }
    return made
  }

  const host: RunHost = {
    attach,
    kind,
    inBand,
    seed,
    caches,
    lockfileHashes,
    depsTables,
    staleModules: (workerId) => {
      // The pool asks as the worker takes one of this run's files: from now on it is this run's.
      inherited.delete(workerId)
      return stale.take(workerId)
    },
    onProvided: (values) => {
      // A warm worker keeps what the setup provided when it booted: new values need new workers.
      const bytes = serialize(values)
      if (provided !== undefined && !bytes.equals(provided)) pool.retire(() => true)
      provided = bytes
    },
    openRecordedGraph: (path) => {
      let graph = graphs.get(path)
      if (graph === undefined) {
        graph = openRecordedGraph(path)
        graphs.set(path, graph)
      }
      return graph
    },
    selectAffected: async (member, everything, selection, recorded) => {
      const project = projects[member.projectIndex]
      if (project === undefined) return []
      const paths = selection.kind === 'related' ? selection.paths : selection.changed.changedFiles
      if (paths.length === 0) return []
      // After every update so far, and before any batch that comes while it reads.
      const related = await serialized(async () => {
        const { index } = await indexOf(member.projectIndex, member.cacheProject, recorded)
        const reached = new Set(index.related(paths))
        try {
          await index.save()
        } catch {
          // The edge cache is a convenience: an unwritable directory costs the next start its warmth.
        }
        return reached
      })
      return everything.filter((file) => related.has(resolve(project.rootDir, file.relativePath)))
    },
  }

  const listeners = new Set<(batch: readonly WatchEvent[]) => void>()
  function onBatch(batch: readonly WatchEvent[]): void {
    stale.changed(batch.map((event) => event.path))
    const which = retirementFor(batch)
    if (which !== undefined) pool.retire(which)
    const made = [...indexes.values()]
    void serialized(async () => {
      for (const entry of made) {
        try {
          await (await entry).index.update(batch)
        } catch (error) {
          reportError(error)
        }
      }
    })
    for (const listener of listeners) {
      // One listener that throws must not keep the others from the batch, nor escape the timer.
      try {
        listener(batch)
      } catch (error) {
        reportError(error)
      }
    }
  }

  const coalescer = createCoalescer({
    emit: onBatch,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  const source = options.changes ?? (await watcherSource(projects, options))
  const watching = await source({
    event: (event) => coalescer.push(event),
    error: reportError,
  })

  let running: Promise<RunSummary> | undefined
  let controller: AbortController | undefined
  let closing: Promise<void> | undefined

  return {
    get running() {
      return running !== undefined
    },
    async run(runOptions) {
      if (closing !== undefined) {
        throw new OrchestratorError('ORCH_BAD_OPTION', 'The watch session is closed.')
      }
      if (running !== undefined) {
        throw new OrchestratorError('ORCH_BAD_OPTION', 'A watch run is already going.')
      }
      const runController = new AbortController()
      controller = runController
      const settings: WatchSessionRunSettings = {
        ...(options.pool === undefined ? {} : { pool: options.pool }),
        ...(options.cache === undefined ? {} : { cache: options.cache }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
        ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
        ...(options.entry === undefined ? {} : { entry: options.entry }),
        ...(options.root === undefined ? {} : { root: options.root }),
        ...(options.globalSetup === undefined ? {} : { globalSetup: options.globalSetup }),
        ...(options.forceSignal === undefined ? {} : { forceSignal: options.forceSignal }),
        ...(inBand ? { runInBand: true } : {}),
      }
      const work = (async () => {
        await applied
        return runProjectsOn(
          projects,
          { ...runOptions, ...settings, signal: runController.signal },
          host,
        )
      })()
      running = work
      try {
        return await work
      } finally {
        running = undefined
        if (controller === runController) controller = undefined
      }
    },
    interrupt() {
      controller?.abort()
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closing ??= (async () => {
        try {
          try {
            watching.close()
          } finally {
            coalescer.close()
            listeners.clear()
            controller?.abort()
            await running?.catch(() => {})
          }
        } finally {
          // Whatever the change source did, no worker outlives the session.
          await pool.close()
        }
        await applied
        for (const made of indexes.values()) {
          try {
            ;(await made).loader[Symbol.dispose]()
          } catch {
            // An index that never got made has no loader to dispose.
          }
        }
      })()
      return closing
    },
  }
}

/** The default change source: a watcher over every project's roots, keeping what a crawl keeps. */
async function watcherSource(
  projects: readonly ResolvedProject[],
  options: WatchSessionOptions,
): Promise<ChangeSource> {
  const crawls = await Promise.all(
    projects.map((project) =>
      crawlProject(
        project,
        options.ignorePatterns === undefined ? {} : { ignorePatterns: options.ignorePatterns },
      ),
    ),
  )
  const roots = outermost(
    projects.flatMap((project) =>
      (project.discovery?.roots ?? [project.rootDir]).map((root) => resolve(root)),
    ),
  )
  const isRelevant = options.isRelevant ?? (() => true)
  // A `package.json` steers resolution even in a project whose crawl lists no `json`.
  const keeps = (path: string): boolean =>
    isRelevant(path) &&
    (basename(path) === 'package.json' || crawls.some((crawl) => crawl.keeps(path)))
  return async (sink) =>
    createWatcher({
      roots,
      keeps,
      onEvent: sink.event,
      onError: sink.error,
      ...(options.perDirectory === undefined ? {} : { perDirectory: options.perDirectory }),
    })
}

/** The roots none of the others contains, once each. */
function outermost(roots: readonly string[]): string[] {
  const unique = [...new Set(roots)].sort()
  return unique.filter(
    (root) => !unique.some((other) => other !== root && root.startsWith(other + sep)),
  )
}
