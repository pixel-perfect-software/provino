// `@jest/test-result` 30.5.2 `packages/jest-test-result/src/helpers.ts`, rebuilt (D103): the empty
// results and `addResult`, which folds a file's result into the run's. `helpers.test.ts` holds each
// to the real package.
import type { AggregatedResult, AssertionResult, SerializableError, TestResult } from './types.ts'

/**
 * An empty run (`makeEmptyAggregatedTestResult`, helpers.ts L16-L47).
 * @public
 */
export function makeEmptyAggregatedTestResult(): AggregatedResult {
  return {
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 0,
    numPassedTests: 0,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numRuntimeErrorTestSuites: 0,
    numTodoTests: 0,
    numTotalTestSuites: 0,
    numTotalTests: 0,
    openHandles: [],
    snapshot: {
      added: 0,
      didUpdate: false,
      failure: false,
      filesAdded: 0,
      filesRemoved: 0,
      filesRemovedList: [],
      filesUnmatched: 0,
      filesUpdated: 0,
      matched: 0,
      total: 0,
      unchecked: 0,
      uncheckedKeysByFile: [],
      unmatched: 0,
      updated: 0,
    },
    startTime: 0,
    success: true,
    testResults: [],
    wasInterrupted: false,
  }
}

/** The zeroed `perfStats` and `snapshot` of an empty file result (helpers.ts L93-L115). */
function emptyParts(): Pick<TestResult, 'perfStats' | 'snapshot'> {
  return {
    perfStats: {
      end: 0,
      loadTestEnvironmentEnd: 0,
      loadTestEnvironmentStart: 0,
      runtime: 0,
      setupAfterEnvEnd: 0,
      setupAfterEnvStart: 0,
      setupFilesEnd: 0,
      setupFilesStart: 0,
      slow: false,
      start: 0,
    },
    snapshot: {
      added: 0,
      fileDeleted: false,
      matched: 0,
      unchecked: 0,
      uncheckedKeys: [],
      unmatched: 0,
      updated: 0,
    },
  }
}

/**
 * A file's empty result (`createEmptyTestResult`, helpers.ts L89-L117).
 * @public
 */
export function createEmptyTestResult(): TestResult {
  return {
    leaks: false,
    numFailingTests: 0,
    numPassingTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    openHandles: [],
    ...emptyParts(),
    skipped: false,
    testFilePath: '',
    testResults: [],
  }
}

/**
 * The result of a file that failed to run (`buildFailureTestResult`, helpers.ts L49-L77).
 * @public
 */
export function buildFailureTestResult(testPath: string, err: SerializableError): TestResult {
  return {
    console: undefined,
    displayName: undefined,
    failureMessage: null,
    leaks: false,
    numFailingTests: 0,
    numPassingTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    openHandles: [],
    ...emptyParts(),
    skipped: false,
    testExecError: err,
    testFilePath: testPath,
    testResults: [],
  }
}

/**
 * Adds a file's result to the run's (`addResult`, helpers.ts L79-L151). Mutates `aggregated` and
 * sets `testResult.numTodoTests` to 0 when it is missing, as Jest does.
 * @public
 */
export function addResult(aggregated: AggregatedResult, testResult: TestResult): void {
  if (!testResult.numTodoTests) testResult.numTodoTests = 0
  aggregated.testResults.push(testResult)
  aggregated.numTotalTests +=
    testResult.numPassingTests +
    testResult.numFailingTests +
    testResult.numPendingTests +
    testResult.numTodoTests
  aggregated.numFailedTests += testResult.numFailingTests
  aggregated.numPassedTests += testResult.numPassingTests
  aggregated.numPendingTests += testResult.numPendingTests
  aggregated.numTodoTests += testResult.numTodoTests
  if (testResult.testExecError) aggregated.numRuntimeErrorTestSuites++
  if (testResult.skipped) {
    aggregated.numPendingTestSuites++
  } else if (testResult.numFailingTests > 0 || testResult.testExecError) {
    aggregated.numFailedTestSuites++
  } else {
    aggregated.numPassedTestSuites++
  }
  const { snapshot } = testResult
  if (snapshot.added) aggregated.snapshot.filesAdded++
  if (snapshot.fileDeleted) aggregated.snapshot.filesRemoved++
  if (snapshot.unmatched) aggregated.snapshot.filesUnmatched++
  if (snapshot.updated) aggregated.snapshot.filesUpdated++
  aggregated.snapshot.added += snapshot.added
  aggregated.snapshot.matched += snapshot.matched
  aggregated.snapshot.unchecked += snapshot.unchecked
  if (snapshot.uncheckedKeys?.length > 0) {
    aggregated.snapshot.uncheckedKeysByFile.push({
      filePath: testResult.testFilePath,
      keys: snapshot.uncheckedKeys,
    })
  }
  aggregated.snapshot.unmatched += snapshot.unmatched
  aggregated.snapshot.updated += snapshot.updated
  aggregated.snapshot.total +=
    snapshot.added + snapshot.matched + snapshot.unmatched + snapshot.updated
}

/**
 * A file's result built from its tests' results, with the counts by status
 * (`makeCollectedTestResult`, helpers.ts L153-L185, used by `--collectTests`).
 * @public
 */
export function makeCollectedTestResult(
  testResults: AssertionResult[],
  options: { displayName: TestResult['displayName']; testFilePath: string },
): TestResult {
  const count = (status: AssertionResult['status']): number =>
    testResults.filter((result) => result.status === status).length
  const numFailingTests = count('failed')
  const numPassingTests = count('passed')
  const numTodoTests = count('todo')
  return {
    ...createEmptyTestResult(),
    displayName: options.displayName,
    numFailingTests,
    numPassingTests,
    numPendingTests: testResults.length - numFailingTests - numPassingTests - numTodoTests,
    numTodoTests,
    testFilePath: options.testFilePath,
    testResults,
  }
}
