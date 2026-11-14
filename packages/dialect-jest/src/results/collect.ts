// The run's results as Jest has them (D103): a neutral reporter that folds the bus's events into
// an `AggregatedResult`, the way `TestScheduler.scheduleTests` folds a runner's (TestScheduler.ts
// 30.5.2 L100-L215). Register it before every other reporter, so that by the time one hears
// `file:end` the file is already in the aggregate.
import { join } from 'node:path'
import type {
  FileInfo,
  Reporter,
  SerializedError,
  TaskId,
  TaskNode,
  TestTask,
} from '@provino/types'
import {
  type BuildOptions,
  type FileEvents,
  finishAggregated,
  ordersOf,
  type RunEnd,
  type TestRecord,
  testsInOrder,
  toAssertionResult,
  toTestResult,
} from './build.ts'
import {
  formatFileError,
  formatRetryError,
  formatTestFailures,
  type StackTraceConfig,
} from './failure-message.ts'
import { addResult, makeEmptyAggregatedTestResult } from './helpers.ts'
import type {
  AggregatedResult,
  AssertionResult,
  ConsoleEntry,
  DisplayName,
  Test,
  TestCaseStartInfo,
  TestContext,
  TestResult,
} from './types.ts'

/**
 * What the collector reads of a project's config.
 * @public
 */
export interface ProjectConfigLike extends StackTraceConfig {
  readonly displayName?: DisplayName | undefined
  readonly slowTestThreshold?: number
  /** Jest reads `testLocationInResults` from the project's config (`--testLocationInResults`). */
  readonly testLocationInResults: boolean
}

/**
 * What the collector reads of the run's global config.
 * @public
 */
export interface GlobalConfigLike {
  readonly noStackTrace: boolean
  /** `--silent`: no console buffer (`runTest.ts` uses a `NullConsole`). */
  readonly silent?: boolean | undefined
  /** `--verbose`: the console prints as it is written, so no buffer is kept. */
  readonly verbose?: boolean | undefined
}

/**
 * What `createJestResults` needs.
 * @public
 */
export interface JestResultsOptions<Config extends ProjectConfigLike> {
  readonly globalConfig: GlobalConfigLike
  /** The run's projects in the order of `FileInfo.projectIndex`. */
  readonly projectConfigs: readonly Config[]
  /** The run only collects (`--collectTests`): each file's result is `makeCollectedTestResult`'s. */
  readonly collectOnly?: boolean
  /** The clock (`Date.now`), injected so a test can fix it. */
  readonly now?: () => number
}

/**
 * The collector `createJestResults` returns.
 * @public
 */
export interface JestResults<Config extends ProjectConfigLike> {
  /** The neutral reporter, named `jest-results`. */
  readonly reporter: Reporter
  /** The run's results so far; complete after `run:end`. */
  aggregated(): AggregatedResult
  /** A finished file's result. */
  testResultOf(fileId: TaskId): TestResult | undefined
  /**
   * A failed file's `failureMessage` in blocks, as the text reporters print it: each failed test's
   * (`formatResultsErrors` of its assertion, with its id), then the file's own errors. Joined by
   * `\n`, the blocks are `failureMessage`. `undefined` for a file with no failure text.
   */
  failureTextOf(fileId: TaskId): readonly JestFailureBlock[] | undefined
  /** The `Test` Jest's reporters get for a file. */
  testOf(file: FileInfo): Test<Config>
  /** The projects that have a file in the run. */
  contexts(): Set<TestContext<Config>>
  /** A test's result as `onTestCaseResult` gets it (`parseSingleTestResult`), once the test has ended. */
  assertionOf(
    test: TestTask,
    retried?: {
      readonly attempt: number
      readonly state: 'pass' | 'fail' | 'skip'
      readonly errors: readonly SerializedError[]
      readonly passingAssertions?: number
    },
  ): AssertionResult | undefined
  /** What `onTestCaseStart` gets for a test that has started (`createTestCaseStartInfo`). */
  startInfoOf(test: TestTask): TestCaseStartInfo
  /**
   * Tells the aggregate that a reporter failed, which the bus only knows once every reporter has
   * heard the end of the run (Jest's `anyReporterErrors`): `success` goes false.
   */
  reportersFailed(failed: boolean): void
}

/**
 * One block of a failed file's text: a failed test's (`taskId`), or the file's own errors.
 * @public
 */
export interface JestFailureBlock {
  readonly taskId?: TaskId
  readonly text: string
}

interface MutableFile {
  info: FileInfo
  startedAt: number
  tree: readonly TaskNode[] | undefined
  records: Map<TaskId, TestRecord>
  /** The child order of each suite a randomized run shuffled. */
  orders: Map<TaskId, readonly TaskId[]>
  unhandled: SerializedError[]
  /** The file's `console` calls, as `BufferedConsole` keeps them. */
  console: ConsoleEntry[]
}

/**
 * Builds the collector. `file:end` formats the file's failure text with `jest-message-util`, so the
 * handler is async and the bus waits for it.
 * @public
 */
export function createJestResults<Config extends ProjectConfigLike>(
  options: JestResultsOptions<Config>,
): JestResults<Config> {
  const now = options.now ?? Date.now
  const { globalConfig, projectConfigs } = options
  let aggregated = makeEmptyAggregatedTestResult()
  /** How the run ended, kept for `reportersFailed`. */
  let ended: Pick<RunEnd, 'reason' | 'snapshots'> | undefined
  aggregated.success = false
  const files = new Map<TaskId, MutableFile>()
  const results = new Map<TaskId, TestResult>()
  const failureBlocks = new Map<TaskId, readonly JestFailureBlock[]>()
  const contexts = new Map<Config, TestContext<Config>>()

  const configOf = (info: FileInfo): Config => {
    const config = projectConfigs[info.projectIndex ?? 0] ?? projectConfigs[0]
    if (config === undefined) throw new Error('createJestResults needs a project config')
    return config
  }
  const contextOf = (config: Config): TestContext<Config> => {
    let context = contexts.get(config)
    if (context === undefined) {
      context = { config }
      contexts.set(config, context)
    }
    return context
  }
  const pathOf = (info: FileInfo): string => join(configOf(info).rootDir, info.path)
  const stateOf = (info: FileInfo): MutableFile => {
    let file = files.get(info.fileId)
    if (file === undefined) {
      file = {
        info,
        startedAt: now(),
        tree: undefined,
        records: new Map(),
        orders: new Map(),
        unhandled: [],
        console: [],
      }
      files.set(info.fileId, file)
    }
    return file
  }
  const record = (file: MutableFile, id: TaskId): TestRecord | undefined => {
    const known = file.records.get(id)
    if (known !== undefined) return known
    const node = file.tree?.find((candidate) => candidate.id === id)
    if (node?.type !== 'test') return undefined
    const fresh: TestRecord = { task: node, result: undefined, startedAt: null }
    file.records.set(id, fresh)
    return fresh
  }

  const reporter: Reporter = {
    name: 'jest-results',
    'run:start': (_info, all) => {
      aggregated = makeEmptyAggregatedTestResult()
      aggregated.success = false
      ended = undefined
      aggregated.numTotalTestSuites = all.length
      aggregated.startTime = now()
      files.clear()
      results.clear()
      failureBlocks.clear()
      contexts.clear()
    },
    'file:start': (info) => {
      files.set(info.fileId, {
        info,
        startedAt: now(),
        tree: undefined,
        records: new Map(),
        orders: new Map(),
        unhandled: [],
        console: [],
      })
    },
    // `BufferedConsole`'s buffer: a call is kept with its call site, under `--silent` or
    // `--verbose` none is (runTest.ts: a `NullConsole`, a `CustomConsole`). A direct write to a
    // stream isn't a console call.
    console: (info, event) => {
      if (globalConfig.silent === true || globalConfig.verbose === true) return
      if (event.level === null) return
      stateOf(info).console.push({
        message: event.text.replace(/\n$/, ''),
        origin: event.origin ?? '',
        type: event.level,
      })
    },
    'file:collected': (info, event) => {
      stateOf(info).tree = event.tasks
    },
    'task:start': (task) => {
      if (task.type !== 'test') return
      const file = files.get(task.fileId)
      if (file === undefined) return
      const known = record(file, task.id)
      if (known !== undefined) file.records.set(task.id, { ...known, startedAt: now() })
    },
    'task:end': (task, event) => {
      if (event.type === 'suite-end') {
        const order = event.result.childOrder
        if (order !== undefined) files.get(task.fileId)?.orders.set(task.id, order)
        return
      }
      if (task.type !== 'test' || event.type !== 'test-end') return
      const file = files.get(task.fileId)
      const known = file === undefined ? undefined : record(file, task.id)
      if (file === undefined || known === undefined) return
      file.records.set(task.id, { ...known, result: event.result })
    },
    unhandled: (info, event) => {
      if (info === null) return
      const file = stateOf(info)
      // An error charged to a test of another file isn't this file's (the worker reported it while
      // it ran this one): it stays in the run's `unhandled`, out of the file's results.
      const { ownerId } = event
      const ours =
        ownerId === null ||
        ownerId === info.fileId ||
        (file.tree?.some((node) => node.id === ownerId) ?? false)
      if (ours) file.unhandled.push(event.error)
    },
    'file:end': async (fileResult) => {
      const info = fileResult.file
      const file = stateOf(info)
      const config = configOf(info)
      const build: BuildOptions = {
        locations: config.testLocationInResults,
        displayName: config.displayName,
        ...(options.collectOnly === true ? { collectOnly: true } : {}),
        ...(config.slowTestThreshold === undefined
          ? {}
          : { slowTestThreshold: config.slowTestThreshold }),
      }
      const events: FileEvents = {
        info,
        testFilePath: pathOf(info),
        tree: file.tree,
        records: file.records,
        orders: file.orders,
        result: fileResult,
        unhandled: file.unhandled,
        startedAt: file.startedAt,
        endedAt: now(),
      }
      const testResult = toTestResult(events, build)
      testResult.console = file.console.length > 0 ? file.console : undefined
      const stack = { noStackTrace: globalConfig.noStackTrace }
      // The messages go with the assertions by position: two tests can share a full name.
      const ordered =
        file.tree === undefined ? [] : testsInOrder(file.tree, file.records, ordersOf(events))
      for (const [index, assertion] of testResult.testResults.entries()) {
        const errors = ordered[index]?.result?.retryErrors ?? []
        if (errors.length === 0) continue
        assertion.retryMessages = await Promise.all(
          errors.map((error) =>
            formatRetryError(error.stack ?? error.message, config, stack, events.testFilePath),
          ),
        )
      }
      const { testExecError } = testResult
      if (options.collectOnly === true && testExecError === undefined) {
        // Nothing ran, so there is nothing to format.
      } else if (testExecError !== undefined && testResult.testResults.length === 0) {
        const text = await formatFileError(testExecError, config, stack, events.testFilePath)
        testResult.failureMessage = text
        failureBlocks.set(info.fileId, [{ text }])
      } else {
        // `formatResultsErrors` joins one block per failure with `\n`, so formatting each test's
        // assertion alone and joining the texts is Jest's text, with the test each block is for.
        const blocks: JestFailureBlock[] = []
        for (const [index, assertion] of testResult.testResults.entries()) {
          const text = await formatTestFailures([assertion], config, stack, events.testFilePath)
          if (text === null) continue
          const taskId = ordered[index]?.task.id
          blocks.push(taskId === undefined ? { text } : { taskId, text })
        }
        if (testExecError !== undefined) {
          const errors = [...fileResult.errors, ...file.unhandled]
          const text = await Promise.all(
            errors.map((error) =>
              formatFileError(
                { message: error.message, stack: error.stack ?? null },
                config,
                stack,
                events.testFilePath,
              ),
            ),
          )
          // Jest's `${message ?? ''}\n\n${errors}`: the join adds one of the two newlines.
          blocks.push({ text: `${blocks.length === 0 ? '\n\n' : '\n'}${text.join('\n')}` })
        }
        testResult.failureMessage =
          blocks.length === 0 ? null : blocks.map((block) => block.text).join('\n')
        if (blocks.length > 0) failureBlocks.set(info.fileId, blocks)
      }
      results.set(info.fileId, testResult)
      addResult(aggregated, testResult)
      contextOf(config)
    },
    'run:end': (summary) => {
      ended = { reason: summary.reason, snapshots: summary.snapshots }
      finishAggregated(aggregated, { ...ended, reporterFailed: false })
      // Jest computes `success` only after the dispatcher has run `onRunComplete` (TestScheduler.ts
      // L338-L352, L486-L491): a reporter hears `false`. `reportersFailed` settles it.
      aggregated.success = false
      aggregated.openHandles = (summary.openHandles ?? []).map((handle) =>
        Object.assign(new Error(handle.type), {
          stack: [`Error: ${handle.type}`, ...handle.frames].join('\n'),
        }),
      )
    },
  }

  return {
    reporter,
    aggregated: () => aggregated,
    testResultOf: (fileId) => results.get(fileId),
    failureTextOf: (fileId) => failureBlocks.get(fileId),
    testOf: (info) => ({ context: contextOf(configOf(info)), path: pathOf(info) }),
    contexts: () => new Set(contexts.values()),
    assertionOf: (test, retried) => {
      const file = files.get(test.fileId)
      const known = file === undefined ? undefined : record(file, test.id)
      if (file === undefined || known === undefined) return undefined
      const config = configOf(file.info)
      // An attempt that is retried: jest-circus reports its `test_done` with what the attempt left,
      // `invocations` the attempts so far (the hook-order recording). A test's own retry follows a
      // failure; a dropped describe attempt (`entireDescribe`) is reported for every test in it,
      // passed or failed, with its passing assertions (`cli/retry-entire-describe-reporter`).
      const shown: TestRecord =
        retried === undefined
          ? known
          : {
              ...known,
              result: {
                state: retried.state,
                durationMs: 0,
                startTime: 0,
                errors: retried.errors,
                retryErrors: [],
                attempts: retried.attempt + 1,
                repeatIndex: 0,
                assertions: 0,
                passingAssertions: retried.passingAssertions ?? 0,
              },
            }
      return toAssertionResult(shown, {
        locations: config.testLocationInResults,
        displayName: config.displayName,
      })
    },
    startInfoOf: (test) => {
      const file = files.get(test.fileId)
      return {
        ancestorTitles: test.fullName.slice(0, -1),
        fullName: test.fullName.join(' '),
        mode: test.mode === 'run' ? undefined : test.mode,
        startedAt: file?.records.get(test.id)?.startedAt ?? null,
        title: test.fullName.at(-1) ?? test.name,
      }
    },
    reportersFailed: (failed) => {
      if (ended !== undefined) finishAggregated(aggregated, { ...ended, reporterFailed: failed })
    },
  }
}
