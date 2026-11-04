// `createRuntime`: one per worker. It wires the collector, the executor, the global API and the
// `LazyHost`, and runs files one at a time: collect (through the caller's `ImportFile`), build the
// tree, run it, and report every step to the `EventSink`.
import { relative, sep } from 'node:path'
import type { BehaviourLoader } from '@provino/policy'
import type {
  CorePolicy,
  EventSink,
  ImportFile,
  LazyHost,
  TaskResult,
  TestRunHandle,
} from '@provino/types'
import { createApi, type RuntimeApi } from './collector/api.ts'
import { Collector } from './collector/collector.ts'
import { type FinalizeOptions, fileIdOf, finalize } from './collector/finalize.ts'
import { newFileState } from './collector/nodes.ts'
import { type CurrentTestService, currentTest, reportAsyncContext } from './current/current-test.ts'
import { CoreError, serializeError } from './errors.ts'
import { capturedTimers, createDeadlines, type RealTimers } from './executor/deadline.ts'
import { Executor, type Outcome, taskResult } from './executor/executor.ts'
import type { FileState } from './internal/model.ts'
import { createLazyHost } from './lazy-host.ts'

/**
 * What a runtime is built from.
 * @public
 */
export interface RuntimeOptions {
  readonly policy: CorePolicy
  /** Loads `formatEachTitle` and `orderHooks` (the worker's one loader). */
  readonly behaviours: BehaviourLoader
  readonly sink: EventSink
  /** Loads a test file; the worker passes the loader's import. */
  readonly importFile: ImportFile
  /** Test paths are reported relative to this directory, in POSIX form. */
  readonly rootDir: string
  /** Part of every task id. Default `''`. */
  readonly projectName?: string
  /** Whether this is a CI run (`allowOnly: 'not-in-ci'`). Default `false`. */
  readonly ci?: boolean
  /** Capture task and hook locations. Default `true`. */
  readonly locations?: boolean
  /** `-t`: tests whose joined full name doesn't match are skipped. */
  readonly testNamePattern?: string | RegExp
  /** Only these test ids run. */
  readonly testIds?: readonly string[]
  /** The timers deadlines use. Default: those global when core loaded. */
  readonly realTimers?: RealTimers
  /** A monotonic clock in ms. Default `performance.now`. */
  readonly now?: () => number
}

/**
 * What applies to one file only.
 * @public
 */
export interface RunFileOptions {
  /** Only tests (or suites) on these lines run (Vitest's `file:line`). */
  readonly lines?: readonly number[]
  /**
   * `-t` for this file only: replaces the runtime's `testNamePattern`. A string that is not a valid
   * regular expression fails the file (`CORE_INVALID_ARGUMENT`, the `SyntaxError` as its cause)
   * before it is imported.
   */
  readonly testNamePattern?: string | RegExp
  /** Only these test ids run in this file: replaces the runtime's `testIds`. */
  readonly testIds?: readonly string[]
}

/**
 * A worker's test runtime.
 * @public
 */
export interface Runtime {
  /** The global functions (`describe`, `test`, hooks, …) a dialect re-exports. */
  readonly api: RuntimeApi
  readonly currentTest: CurrentTestService
  /** What `@provino/lazy` builds on. */
  readonly lazyHost: LazyHost
  /**
   * Collects and runs one test file; resolves with the file's result, whatever its tests do.
   * Rejects with `CORE_BUSY` while another file of this runtime is still collecting or running.
   */
  runFile(path: string, options?: RunFileOptions): Promise<TaskResult>
  /** Runs the worker teardowns (last first); rejects with an `AggregateError` if any failed. */
  dispose(): Promise<void>
}

/**
 * Builds a runtime. Async because it loads the policy's behaviour functions first, so
 * registration stays synchronous.
 * @public
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  reportAsyncContext()
  const { policy, sink } = options
  const now = options.now ?? (() => performance.now())
  const timers = options.realTimers ?? capturedTimers
  const deadlines = createDeadlines(policy.timeouts, timers, now)
  const projectName = options.projectName ?? ''
  const formatEachTitle = await options.behaviours.load(policy.formatEachTitle)
  const orderHooks =
    policy.orderHooks === null ? undefined : await options.behaviours.load(policy.orderHooks)
  const runs = new WeakMap<object, TestRunHandle>()
  const workerTeardowns: Array<() => unknown> = []
  const collector = new Collector({
    policy,
    formatEachTitle,
    locations: options.locations ?? true,
    onLateRegistration(error: CoreError, chargedTo: FileState | undefined) {
      sink.emit({
        type: 'unhandled-error',
        ownerId: chargedTo?.root.id ?? null,
        lastTestId: null,
        origin: 'late-registration',
        error: serializeError(error),
        t: now(),
      })
    },
  })
  const executor = new Executor({ policy, orderHooks, sink, deadlines, timers, now, runs })
  const pattern = options.testNamePattern
  const finalizeOptions: Omit<FinalizeOptions, 'lines'> = {
    policy,
    projectName,
    ci: options.ci ?? false,
    testNamePattern:
      pattern === undefined ? undefined : toRegExp(pattern, policy.testNamePatternFlags),
    testIds: options.testIds === undefined ? undefined : new Set(options.testIds),
  }

  /**
   * The runtime's filters, with the ones this file's options give instead. Compiles the file's
   * `testNamePattern`, so a pattern that is not a valid regular expression throws here.
   */
  function finalizeOptionsFor(fileOptions: RunFileOptions): FinalizeOptions {
    const { testNamePattern, testIds, lines } = fileOptions
    return {
      ...finalizeOptions,
      ...(testNamePattern === undefined
        ? {}
        : { testNamePattern: toRegExp(testNamePattern, policy.testNamePatternFlags) }),
      ...(testIds === undefined ? {} : { testIds: new Set(testIds) }),
      lines: lines === undefined ? undefined : new Set(lines),
    }
  }

  /**
   * This file's filters, built before the file is imported. `undefined` when they can't be built
   * (a `testNamePattern` that is not a valid regular expression): the reason is then recorded as
   * the file's error, wrapped with the `SyntaxError` as its cause, and the file is not collected.
   */
  function filtersFor(file: FileState, fileOptions: RunFileOptions): FinalizeOptions | undefined {
    try {
      return finalizeOptionsFor(fileOptions)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      file.errors.push(
        new CoreError(
          'CORE_INVALID_ARGUMENT',
          `Invalid testNamePattern for ${file.relativePath}: ${reason}`,
          { cause },
        ),
      )
      return undefined
    }
  }

  /**
   * Collects a file, then calls the `onCollected` listeners. `false` when either failed: the file
   * then reports no tasks, as both runners do for a collection failure.
   */
  async function collect(file: FileState): Promise<boolean> {
    let collected = true
    try {
      await collector.collect(file, () => options.importFile(file.path))
    } catch (error) {
      collected = false
      file.errors.push(error)
    }
    collector.close(file)
    if (!(await notifyCollected(file))) collected = false
    if (!collected) file.root.children.length = 0
    return collected
  }

  /** Calls each `onCollected` listener, awaiting what it returns; `false` when one failed. */
  async function notifyCollected(file: FileState): Promise<boolean> {
    let ok = true
    for (const listener of file.onCollected) {
      try {
        // A listener validates what was collected; one that never settles must not hang the file.
        await deadlines.call(() => listener(file.handle), {
          what: 'listener',
          timeoutMs: policy.timeouts.hook,
          catchSyncOverrun: false,
        })
      } catch (error) {
        ok = false
        file.errors.push(error)
      }
    }
    return ok
  }

  async function runFile(path: string, fileOptions: RunFileOptions = {}): Promise<TaskResult> {
    const busy = collector.file
    if (busy !== undefined) {
      throw new CoreError('CORE_BUSY', `"${busy.path}" is still collecting or running`)
    }
    const relativePath = relative(options.rootDir, path).split(sep).join('/')
    const file = newFileState(path, relativePath, new AbortController().signal)
    const fileId = fileIdOf(projectName, relativePath)
    const start = now()
    sink.emit({ type: 'file-collect-start', fileId, path: relativePath, t: start })
    let outcome: Outcome = 'fail'
    try {
      // Before collection: an invalid per-file pattern skips the import and reports no tasks, but
      // the file still gets its `file-collect-end` and `file-end`.
      const filters = filtersFor(file, fileOptions)
      const collected = filters !== undefined && (await collect(file))
      const tasks = filters === undefined ? [] : finalize(file, filters)
      const errors = file.errors.map(serializeError)
      sink.emit({ type: 'file-collect-end', fileId, tasks, errors, t: now() })
      if (collected) outcome = await executor.runFile(file)
    } catch (error) {
      file.errors.push(error)
    } finally {
      // The file's own teardowns run whatever happened above: a failed collection, a failed
      // listener, a root `aroundAll` that never ran the suite.
      file.errors.push(...(await deadlines.drain(file.handle.teardowns)))
      collector.release(file)
    }
    const failed = file.errors.length > 0 || outcome === 'fail'
    const end = now()
    const result = taskResult(failed ? 'fail' : outcome, start, end, file.errors)
    sink.emit({ type: 'file-end', fileId, result, t: end })
    return result
  }

  return {
    api: createApi(collector),
    currentTest,
    lazyHost: createLazyHost({ collector, runs, workerTeardowns, workerSlots: new Map() }),
    runFile,
    async dispose(): Promise<void> {
      const errors = await deadlines.drain(workerTeardowns)
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Worker teardowns failed')
      }
    },
  }
}

/** `-t` as a `RegExp`: a string is compiled with the policy's flags. */
function toRegExp(pattern: string | RegExp, flags: string): RegExp {
  return typeof pattern === 'string' ? new RegExp(pattern, flags) : pattern
}
