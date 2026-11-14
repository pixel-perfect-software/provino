// Jest reporter classes on Provino's bus (T11.9): each one is wrapped in a neutral `Reporter` that
// calls the class's hooks the way jest-core's `ReporterDispatcher` and `TestScheduler` do (30.5.2
// `ReporterDispatcher.ts`, `TestScheduler.ts` L248-L330): `onRunStart` before any file,
// `onTestFileStart` (else `onTestStart`) as a file starts, `onTestCaseStart` and
// `onTestCaseResult` per test, `onTestFileResult` (else `onTestResult`) as a file ends, then
// `onRunComplete`, and `getLastError` afterwards.

import type {
  AggregatedResult,
  AssertionResult,
  JestResults,
  ProjectConfigLike,
  Test,
  TestCaseStartInfo,
  TestContext,
  TestResult,
} from '@provino/dialect-jest/results'
import type { FileInfo, Reporter, SerializedError, TaskId } from '@provino/types'

/**
 * What `onRunStart` is given as its second argument (`ReporterOnStartOptions`).
 * @public
 */
export interface JestReporterOnStartOptions {
  estimatedTime: number
  showStatus: boolean
}

/**
 * What a reporter class is constructed with as its third argument (`ReporterContext`,
 * `@jest/reporters` `types.ts`).
 * @public
 */
export interface JestReporterContext {
  firstRun: boolean
  previousSuccess: boolean
  changedFiles?: Set<string>
  sourcesRelatedToTestsInChangedFiles?: Set<string>
}

/**
 * A Jest reporter (`Reporter`, `@jest/reporters`): every hook is optional.
 * @public
 */
export interface JestReporterInstance {
  readonly onTestResult?: (
    test: Test,
    testResult: TestResult,
    aggregated: AggregatedResult,
  ) => Promise<void> | void
  readonly onTestFileResult?: (
    test: Test,
    testResult: TestResult,
    aggregated: AggregatedResult,
  ) => Promise<void> | void
  readonly onTestCaseStart?: (test: Test, info: TestCaseStartInfo) => Promise<void> | void
  readonly onTestCaseResult?: (test: Test, result: AssertionResult) => Promise<void> | void
  readonly onRunStart?: (
    aggregated: AggregatedResult,
    options: JestReporterOnStartOptions,
  ) => Promise<void> | void
  readonly onTestStart?: (test: Test) => Promise<void> | void
  readonly onTestFileStart?: (test: Test) => Promise<void> | void
  readonly onRunComplete?: (
    contexts: Set<TestContext>,
    aggregated: AggregatedResult,
  ) => Promise<void> | void
  readonly getLastError?: () => unknown
}

/**
 * A Jest reporter class, as a `reporters` entry's module exports it (`ReporterConstructor`).
 * @public
 */
export type JestReporterClass = new (
  globalConfig: never,
  options: Readonly<Record<string, unknown>>,
  context: JestReporterContext,
) => JestReporterInstance

/**
 * One custom reporter of the run: where it came from, its options, and its class.
 * @public
 */
export interface JestLoadedReporter {
  readonly path: string
  readonly options: Readonly<Record<string, unknown>>
  readonly Class: JestReporterClass
}

/**
 * What `createJestReporterHost` needs.
 * @public
 */
export interface JestReporterHostOptions<Config extends ProjectConfigLike> {
  /** The collector that is registered before the host's reporters. */
  readonly results: JestResults<Config>
  /** The global config each class is constructed with. */
  readonly globalConfig: unknown
  readonly entries: readonly JestLoadedReporter[]
  readonly context?: JestReporterContext
  /**
   * `showStatus` of `onRunStart` (Jest: not in band). Default: not `RunInfo.inBand`, the run's own
   * decision, read at `run:start`.
   */
  readonly showStatus?: boolean
  /**
   * Hear one file at a time, as Jest does in band: a file's start and its events wait until the
   * file before it has had its result. Default: `showStatus` is false.
   */
  readonly serial?: boolean
}

/**
 * Holds the events of files that start while another is running, and replays them, in order, once
 * the one before has ended (`runInBand` in Jest runs one file at a time, and the pool here hands a
 * worker its next file before the last one has ended).
 */
function createGate(): {
  /** Starts a run: nothing held, and one file at a time when `serial`. */
  reset(serial: boolean): void
  start(id: TaskId, work: () => Promise<void>): Promise<void>
  run(id: TaskId, work: () => Promise<void>): Promise<void>
  end(id: TaskId, work: () => Promise<void>): Promise<void>
} {
  let serial = false
  let active: TaskId | undefined
  let queue: TaskId[] = []
  let held = new Map<TaskId, (() => Promise<void>)[]>()
  let ended = new Set<TaskId>()

  async function next(): Promise<void> {
    while (active === undefined) {
      const id = queue.shift()
      if (id === undefined) return
      active = id
      const list = held.get(id) ?? []
      held.delete(id)
      while (list.length > 0) await list.shift()?.()
      if (ended.delete(id)) active = undefined
    }
  }

  return {
    reset(serialRun) {
      serial = serialRun
      active = undefined
      queue = []
      held = new Map()
      ended = new Set()
    },
    async start(id, work) {
      if (!serial || active === undefined) {
        active = id
        await work()
        return
      }
      queue.push(id)
      held.set(id, [work])
    },
    async run(id, work) {
      if (!serial || id === active) return work()
      const list = held.get(id)
      if (list === undefined) return work()
      list.push(work)
    },
    async end(id, work) {
      if (!serial) return work()
      if (id !== active) {
        const list = held.get(id)
        if (list === undefined) return work()
        list.push(work)
        ended.add(id)
        return
      }
      await work()
      active = undefined
      await next()
    },
  }
}

function serialize(error: Error): SerializedError {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  }
}

/**
 * One neutral reporter per entry, in order, then one that frees each file's console buffer after
 * every reporter has seen the file (`ReporterDispatcher.onTestFileResult`'s
 * `testResult.console = undefined`). Register the collector first and the host's reporters after.
 * A class that fails to construct fails its `run:start`, with Jest's wording.
 * @public
 */
export function createJestReporterHost<Config extends ProjectConfigLike>(
  options: JestReporterHostOptions<Config>,
): Reporter[] {
  const { results } = options
  const context = options.context ?? { firstRun: true, previousSuccess: true }
  const infos = new Map<TaskId, FileInfo>()

  const wrapped = options.entries.map((entry): Reporter => {
    let instance: JestReporterInstance | undefined
    const gate = createGate()
    const testOf = (fileId: TaskId): Test | undefined => {
      const info = infos.get(fileId)
      return info === undefined ? undefined : (results.testOf(info) as Test)
    }
    return {
      name: `jest-reporter:${entry.path}`,
      async 'run:start'(info) {
        const showStatus = options.showStatus ?? info.inBand !== true
        infos.clear()
        gate.reset(options.serial ?? !showStatus)
        try {
          instance = new entry.Class(options.globalConfig as never, entry.options, context)
        } catch (error) {
          // `TestScheduler._addCustomReporter` (L440-L451)
          const message = error instanceof Error ? error.message : ''
          throw new Error(
            `An error occurred while adding the reporter at path "${entry.path}".\n${message}`,
            { cause: error },
          )
        }
        await instance.onRunStart?.(results.aggregated(), {
          estimatedTime: 0,
          showStatus,
        })
      },
      async 'file:start'(file) {
        infos.set(file.fileId, file)
        await gate.start(file.fileId, async () => {
          const test = results.testOf(file) as Test
          if (instance?.onTestFileStart !== undefined) await instance.onTestFileStart(test)
          else await instance?.onTestStart?.(test)
        })
      },
      async 'test:attempt-start'(task) {
        if (task.type !== 'test') return
        await gate.run(task.fileId, async () => {
          const test = testOf(task.fileId)
          if (test === undefined) return
          await instance?.onTestCaseStart?.(test, results.startInfoOf(task))
        })
      },
      async 'task:end'(task, event) {
        // A skipped test has no case result in jest-circus (`test_skip` isn't reported); a todo one has.
        if (task.type !== 'test' || event.type !== 'test-end' || event.result.state === 'skip')
          return
        await gate.run(task.fileId, async () => {
          const test = testOf(task.fileId)
          const assertion = results.assertionOf(task)
          if (test === undefined || assertion === undefined) return
          await instance?.onTestCaseResult?.(test, assertion)
        })
      },
      // An attempt that will be retried is reported as a failed test, as `test_done` is for it.
      async 'test:attempt-end'(task, event) {
        if (!event.willRetry) return
        await gate.run(task.fileId, async () => {
          const test = testOf(task.fileId)
          const assertion = results.assertionOf(task, event)
          if (test === undefined || assertion === undefined) return
          await instance?.onTestCaseResult?.(test, assertion)
        })
      },
      async 'file:end'(file) {
        await gate.end(file.file.fileId, async () => {
          const testResult = results.testResultOf(file.file.fileId)
          const test = testOf(file.file.fileId)
          if (testResult === undefined || test === undefined) return
          if (instance?.onTestFileResult !== undefined) {
            await instance.onTestFileResult(test, testResult, results.aggregated())
          } else {
            await instance?.onTestResult?.(test, testResult, results.aggregated())
          }
        })
      },
      async 'run:end'() {
        await instance?.onRunComplete?.(
          results.contexts() as Set<TestContext>,
          results.aggregated(),
        )
      },
      lastError() {
        // Jest keeps any truthy value (`ReporterDispatcher.getErrors`).
        const error = instance?.getLastError?.()
        if (!error) return undefined
        return error instanceof Error ? serialize(error) : { name: 'Error', message: String(error) }
      },
    }
  })

  const release: Reporter = {
    name: 'jest-reporter-release',
    'file:end'(file) {
      const testResult = results.testResultOf(file.file.fileId)
      if (testResult !== undefined) testResult.console = undefined
    },
  }
  return [...wrapped, release]
}
