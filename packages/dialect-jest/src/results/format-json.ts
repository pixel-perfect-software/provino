// `--json`'s text: `@jest/test-result`'s `formatTestResults` (30.5.2, formatTestResults.ts) and
// `@jest/core`'s `serializeToJSON` (lib/serializeToJSON.ts), rebuilt (D103).
import type {
  AggregatedResult,
  FormattedTestResult,
  FormattedTestResults,
  TestResult,
} from './types.ts'

/** One file's entry in the JSON (`formatTestResult`, formatTestResults.ts L18-L69). */
function formatTestResult(testResult: TestResult): FormattedTestResult {
  if (testResult.testExecError) {
    const now = Date.now()
    return {
      assertionResults: testResult.testResults,
      coverage: {},
      endTime: now,
      message: testResult.failureMessage ?? testResult.testExecError.message,
      name: testResult.testFilePath,
      startTime: now,
      status: 'failed',
      summary: '',
    }
  }
  if (testResult.skipped) {
    const now = Date.now()
    return {
      assertionResults: testResult.testResults,
      coverage: {},
      endTime: now,
      message: testResult.failureMessage ?? '',
      name: testResult.testFilePath,
      startTime: now,
      status: 'skipped',
      summary: '',
    }
  }
  const allTestsExecuted = testResult.numPendingTests === 0
  const allTestsPassed = testResult.numFailingTests === 0
  return {
    assertionResults: testResult.testResults,
    coverage: testResult.coverage,
    endTime: testResult.perfStats.end,
    message: testResult.failureMessage ?? '',
    name: testResult.testFilePath,
    startTime: testResult.perfStats.start,
    status: allTestsPassed ? (allTestsExecuted ? 'passed' : 'focused') : 'failed',
    summary: '',
  }
}

/**
 * The run's results with each file formatted (`formatTestResults`, formatTestResults.ts L71-L81).
 * @public
 */
export function formatJson(results: AggregatedResult): FormattedTestResults {
  return { ...results, testResults: results.testResults.map(formatTestResult) }
}

/**
 * `JSON.stringify` with what `serializeToJSON` adds: an error as `{ message, name, stack }` and a
 * `bigint` as its literal (`1n`).
 * @public
 */
export function serializeToJson(value: unknown, space?: string | number): string {
  return JSON.stringify(
    value,
    (_key, inner: unknown) => {
      if (inner instanceof Error || Object.prototype.toString.call(inner) === '[object Error]') {
        const error = inner as Error
        return { message: error.message, name: error.name, stack: error.stack }
      }
      if (typeof inner === 'bigint') return `${inner}n`
      return inner
    },
    space,
  )
}
