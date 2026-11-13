// Pure builders (D103): what one file's events say, as Jest's `AssertionResult` and `TestResult`.
// The semantics are `jest-circus` 30.5.2's: `parseSingleTestResult` (utils.ts L507-L539),
// `makeSingleTestResult` (L342-L390) and `runAndTransformResultsToJestFormat`
// (jestAdapterInit.ts L286-L340), plus `jest-runner`'s `skipped` flag (runTest.ts).
import type {
  FileInfo,
  FileResult,
  SerializedError,
  SnapshotRunSummary,
  TaskId,
  TaskNode,
  TaskResult,
  TestTask,
} from '@provino/types'
import { createEmptyTestResult, makeCollectedTestResult } from './helpers.ts'
import type { AggregatedResult, AssertionResult, Status, TestResult } from './types.ts'

/**
 * One test's events, as the collector keeps them.
 * @public
 */
export interface TestRecord {
  readonly task: TestTask
  /** The `task:end` result; absent for a test that never ended (a crashed worker). */
  readonly result: TaskResult | undefined
  /** The coordinator's clock (ms since the epoch) when the test started. */
  readonly startedAt: number | null
  /** The errors of each attempt that was retried, in order. */
  readonly retried: readonly SerializedError[]
}

/**
 * One file's events, as the collector keeps them.
 * @public
 */
export interface FileEvents {
  readonly info: FileInfo
  /** The file's absolute path. */
  readonly testFilePath: string
  /** The file's tree (`file:collected`), or `undefined` when it never got that far. */
  readonly tree: readonly TaskNode[] | undefined
  readonly records: ReadonlyMap<TaskId, TestRecord>
  readonly result: FileResult
  /** Errors a worker reported for the file outside any test. */
  readonly unhandled: readonly SerializedError[]
  /** The coordinator's clock when the file started and ended. */
  readonly startedAt: number
  readonly endedAt: number
}

/**
 * What the build reads of the run's settings.
 * @public
 */
export interface BuildOptions {
  /** `testLocationInResults`: whether each test's location is reported. */
  readonly locations: boolean
  readonly displayName: TestResult['displayName']
  /** `slowTestThreshold`, in seconds (Jest's default 5). */
  readonly slowTestThreshold?: number
  /**
   * The run only collected (`--collectTests`): each test is reported as
   * `collectTestsWithoutRunning` (jestAdapterInit.ts L174-L252) does, with no duration, location,
   * start or invocation, and `makeCollectedTestResult` builds the file's result.
   */
  readonly collectOnly?: boolean
}

/**
 * `flattenErrorStack` (jest-message-util 30.5.2, index.ts L504-L551) over a serialized error: the
 * stack (or the message when it has none, or is missing the message), then each `cause` and each
 * of an aggregate's `errors` as `\n\n[cause]: …` and `\n\n[errors]: …`.
 * @public
 */
export function flattenSerializedError(error: SerializedError): string {
  return flatten(error, new Set())
}

function flatten(error: SerializedError, seen: Set<SerializedError>): string {
  const { message, stack } = error
  let flattened: string
  if (typeof stack === 'string' && stack !== '') {
    // Some errors don't embed the message in the stack; prepend it so it isn't lost.
    flattened =
      message && !stack.includes(message) ? message + stack.replace(/^Error:?\s*\n/, '\n') : stack
  } else {
    flattened = message
  }
  seen.add(error)
  if (error.cause !== undefined) {
    flattened += `\n\n[cause]: ${seen.has(error.cause) ? '[Circular cause]' : flatten(error.cause, seen)}`
  }
  for (const nested of error.errors ?? []) {
    flattened += `\n\n[errors]: ${seen.has(nested) ? '[Circular errors]' : flatten(nested, seen)}`
  }
  seen.delete(error)
  return flattened
}

/** The status Jest reports for a test that ended in `state` (utils.ts L507-L516). */
function statusOf(state: TaskResult['state']): Status {
  switch (state) {
    case 'skip':
      return 'pending'
    case 'todo':
      return 'todo'
    case 'fail':
    case 'running':
      return 'failed'
    case 'pass':
    case 'queued':
      // `queued` is what a collect-only pass says of a test a run would start.
      return 'passed'
    default:
      return state satisfies never
  }
}

/**
 * One test's result. A test that never ended is `failed` with no message (its file's error says
 * why). Jest counts a skipped test's invocations as 1 (`cli/json-vscode-contract`), so does this.
 * @public
 */
export function toAssertionResult(record: TestRecord, options: BuildOptions): AssertionResult {
  const { task, result } = record
  const status = result === undefined ? 'failed' : statusOf(result.state)
  const errors = result?.errors ?? []
  const { location } = task
  const title = task.fullName.at(-1) ?? task.name
  const ran = status === 'passed' || status === 'failed'
  if (options.collectOnly === true) {
    return {
      ancestorTitles: task.fullName.slice(0, -1),
      duration: null,
      failing: task.expectFail,
      failureDetails: [],
      failureMessages: [],
      fullName: task.fullName.join(' '),
      invocations: 0,
      location: null,
      numPassingAsserts: 0,
      retryReasons: [],
      startAt: null,
      status,
      title,
      ...(result?.state === 'queued' ? { wouldRun: true as const } : {}),
    }
  }
  return {
    ancestorTitles: task.fullName.slice(0, -1),
    duration: ran && result !== undefined ? Math.round(result.durationMs) : null,
    failing: task.expectFail,
    failureDetails: errors.map((error) => error.details ?? {}),
    failureMessages: errors.map(flattenSerializedError),
    fullName: task.fullName.join(' '),
    invocations: Math.max(1, result?.attempts ?? 0),
    location:
      options.locations && location !== null
        ? { column: location.column, line: location.line }
        : null,
    numPassingAsserts: result?.passingAssertions ?? 0,
    retryMessages: [],
    retryReasons: record.retried.map(flattenSerializedError),
    startAt: record.startedAt,
    status,
    title,
  }
}

/** The tests of a tree in declaration order (depth first), each with what the events said of it. */
function testsInOrder(
  tree: readonly TaskNode[],
  records: ReadonlyMap<TaskId, TestRecord>,
): TestRecord[] {
  const byId = new Map(tree.map((node) => [node.id, node]))
  const out: TestRecord[] = []
  const visit = (node: TaskNode | undefined): void => {
    if (node === undefined) return
    if (node.type === 'test') {
      const record = records.get(node.id)
      out.push(record ?? { task: node, result: undefined, startedAt: null, retried: [] })
      return
    }
    for (const child of node.children) visit(byId.get(child))
  }
  for (const node of tree) if (node.type === 'file') visit(node)
  return out
}

/** The file's own errors as Jest's `SerializableError`. */
function execErrorOf(errors: readonly SerializedError[]): TestResult['testExecError'] {
  const [first] = errors
  if (first === undefined) return undefined
  return {
    message: first.message,
    stack: first.stack ?? null,
    ...(first.code === undefined ? {} : { code: first.code }),
  }
}

/**
 * What an empty file is reported as: Jest fails a file with no test (TestScheduler.ts L176-L184).
 * @public
 */
export const NO_TESTS_MESSAGE = 'Your test suite must contain at least one test.'

/**
 * One file's `TestResult`, with `failureMessage` left `null` (the text comes from
 * `jest-message-util`, asynchronously: `collect.ts` fills it).
 *
 * - A file that ended with errors and no test that ran, or never collected, is a runtime error:
 *   `testExecError` is its first error.
 * - A file with errors beside tests that ran has `testExecError` `{ message: '', stack }` with the
 *   errors joined by newlines, as Jest does for `unhandledErrors` (jestAdapterInit.ts L314-L319).
 * - A file with neither tests nor errors fails with `Your test suite must contain at least one test.`
 * @public
 */
export function toTestResult(file: FileEvents, options: BuildOptions): TestResult {
  const tests = file.tree === undefined ? [] : testsInOrder(file.tree, file.records)
  const assertionResults = tests.map((record) => toAssertionResult(record, options))
  const count = (status: Status): number =>
    assertionResults.filter((result) => result.status === status).length
  const numFailingTests = count('failed')
  const numPassingTests = count('passed')
  const numPendingTests = count('pending')
  const numTodoTests = count('todo')
  const fileErrors = [...file.result.errors, ...file.unhandled]
  const ran = tests.some((record) => record.result !== undefined)
  let testExecError: TestResult['testExecError']
  if (!ran) {
    testExecError =
      execErrorOf(fileErrors) ??
      (file.result.state === 'fail' && assertionResults.length === 0
        ? { message: NO_TESTS_MESSAGE, stack: new Error(NO_TESTS_MESSAGE).stack ?? null }
        : undefined)
  } else if (fileErrors.length > 0) {
    testExecError = {
      message: '',
      stack: fileErrors.map(flattenSerializedError).join('\n'),
    }
  }
  const failed = testExecError !== undefined && !ran
  if (options.collectOnly === true && testExecError === undefined) {
    // `collectTestsWithoutRunning`: the counts come from the statuses, and nothing else is set.
    return makeCollectedTestResult(assertionResults, {
      displayName: options.displayName,
      testFilePath: file.testFilePath,
    })
  }
  const results = failed ? [] : assertionResults
  const runtime = file.endedAt - file.startedAt
  const { snapshot } = file.result
  const testCount = numPassingTests + numFailingTests + numPendingTests + numTodoTests
  return {
    ...createEmptyTestResult(),
    console: undefined,
    displayName: options.displayName,
    failureMessage: null,
    numFailingTests,
    numPassingTests,
    numPendingTests,
    numTodoTests,
    perfStats: {
      end: file.endedAt,
      loadTestEnvironmentEnd: 0,
      loadTestEnvironmentStart: 0,
      runtime,
      setupAfterEnvEnd: 0,
      setupAfterEnvStart: 0,
      setupFilesEnd: 0,
      setupFilesStart: 0,
      slow: runtime / 1000 > (options.slowTestThreshold ?? 5),
      start: file.startedAt,
    },
    // jest-runner's runTest.ts: `skipped = testCount === numPendingTests`.
    skipped: !failed && testCount === numPendingTests,
    snapshot:
      snapshot === undefined
        ? createEmptyTestResult().snapshot
        : {
            added: snapshot.added,
            fileDeleted: snapshot.fileDeleted,
            matched: snapshot.matched,
            unchecked: snapshot.unchecked,
            uncheckedKeys: [...snapshot.uncheckedKeys],
            unmatched: snapshot.unmatched,
            updated: snapshot.updated,
          },
    ...(testExecError === undefined ? {} : { testExecError }),
    testFilePath: file.testFilePath,
    testResults: results,
  }
}

/**
 * What the end of a run adds to the aggregate.
 * @public
 */
export interface RunEnd {
  readonly reason: 'passed' | 'failed' | 'interrupted' | 'terminated' | 'hangup'
  readonly snapshots: SnapshotRunSummary | undefined
  /** A reporter failed (Jest's `anyReporterErrors`). */
  readonly reporterFailed: boolean
}

/**
 * The aggregate's closing fields (TestScheduler.ts L87-L95 and L198-L212): `didUpdate`, snapshot
 * `failure`, `wasInterrupted` and `success`. Mutates `aggregated`.
 * @public
 */
export function finishAggregated(aggregated: AggregatedResult, end: RunEnd): void {
  const updateAll = end.snapshots?.update === 'all'
  const { snapshot } = aggregated
  snapshot.didUpdate = updateAll
  snapshot.failure = !!(
    !updateAll &&
    (snapshot.unchecked || snapshot.unmatched || snapshot.filesRemoved)
  )
  aggregated.wasInterrupted =
    end.reason === 'interrupted' || end.reason === 'terminated' || end.reason === 'hangup'
  const anyTestFailures = !(
    aggregated.numFailedTests === 0 && aggregated.numRuntimeErrorTestSuites === 0
  )
  aggregated.success = !(anyTestFailures || snapshot.failure || end.reporterFailed)
}
