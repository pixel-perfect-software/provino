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
  TaskNode,
  TaskResult,
  TestRunHandle,
} from '@provino/types'
import { createApi, type RuntimeApi } from './collector/api.ts'
import { Collector } from './collector/collector.ts'
import { fileIdOf, finalize } from './collector/finalize.ts'
import { newFileState } from './collector/nodes.ts'
import { type CurrentTestService, currentTest, reportAsyncContext } from './current/current-test.ts'
import { serializeError } from './errors.ts'
import { capturedTimers, type RealTimers } from './executor/deadline.ts'
import { Executor, type Outcome } from './executor/executor.ts'
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
  /** Only tests (or suites) on these lines run (Vitest's `file:line`). */
  readonly lines?: readonly number[]
  /** The timers deadlines use. Default: those global when core loaded. */
  readonly realTimers?: RealTimers
  /** A monotonic clock in ms. Default `performance.now`. */
  readonly now?: () => number
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
  /** Collects and runs one test file; resolves with the file's result. */
  runFile(path: string): Promise<TaskResult>
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
    onLateRegistration(file, error) {
      const fails = policy.collect.lateRegistration === 'fail-file'
      if (fails) file.errors.push(error)
      sink.emit({
        type: 'unhandled-error',
        ownerId: fails ? file.root.id : null,
        lastTestId: null,
        origin: 'late-registration',
        error: serializeError(error),
        t: now(),
      })
    },
  })
  const executor = new Executor({
    policy,
    orderHooks,
    sink,
    timers: options.realTimers ?? capturedTimers,
    now,
    runs,
  })
  const pattern = options.testNamePattern
  const finalizeOptions = {
    policy,
    projectName,
    ci: options.ci ?? false,
    testNamePattern:
      pattern === undefined
        ? undefined
        : typeof pattern === 'string'
          ? new RegExp(pattern, policy.testNamePatternFlags)
          : pattern,
    testIds: options.testIds === undefined ? undefined : new Set(options.testIds),
    lines: options.lines === undefined ? undefined : new Set(options.lines),
  }

  async function runFile(path: string): Promise<TaskResult> {
    const relativePath = relative(options.rootDir, path).split(sep).join('/')
    const file = newFileState(path, relativePath, new AbortController().signal)
    const fileId = fileIdOf(projectName, relativePath)
    const start = now()
    sink.emit({ type: 'file-collect-start', fileId, path: relativePath, t: start })
    let collected = true
    try {
      await collector.collect(file, () => options.importFile(path))
    } catch (error) {
      collected = false
      file.errors.push(error)
      // A file whose collection failed reports no tasks, as both runners do.
      file.root.children.length = 0
    }
    collector.close(file)
    let tasks: TaskNode[]
    let outcome: Outcome = 'fail'
    try {
      tasks = finalize(file, finalizeOptions)
      sink.emit({
        type: 'file-collect-end',
        fileId,
        tasks,
        errors: file.errors.map(serializeError),
        t: now(),
      })
      for (const listener of file.onCollected) listener(file.handle)
      if (collected) outcome = await executor.runFile(file, tasks)
    } finally {
      collector.release(file)
    }
    const failed = file.errors.length > 0 || outcome === 'fail'
    const result: TaskResult = {
      state: failed ? 'fail' : outcome,
      durationMs: now() - start,
      startTime: start,
      errors: file.errors.map(serializeError),
      retryErrors: [],
      attempts: 0,
      repeatIndex: 0,
      assertions: 0,
      passingAssertions: 0,
    }
    sink.emit({ type: 'file-end', fileId, result, t: now() })
    return result
  }

  return {
    api: createApi(collector, formatEachTitle),
    currentTest,
    lazyHost: createLazyHost({ collector, runs, workerTeardowns, workerSlots: new Map() }),
    runFile,
    async dispose(): Promise<void> {
      const errors: unknown[] = []
      while (workerTeardowns.length > 0) {
        try {
          await workerTeardowns.pop()?.()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Worker teardowns failed')
      }
    },
  }
}
