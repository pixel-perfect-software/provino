import type { AggregatedResult, FormattedTestResults } from '@jest/test-result'
import type { NormalizedRun, NormalizedTest, TestIdentity, TestStatus } from '@provino/types'
import type { JestConvertOptions } from './convert-options.ts'
import { HarnessError } from './errors.ts'
import {
  assembleFile,
  assembleTest,
  type Conversion,
  countersOf,
  errorOf,
  jsonFile,
  type RawFile,
  runOf,
  startConversion,
} from './internal/convert.ts'
import { finiteNumber, isRecord, prop } from './internal/guards.ts'

type JestFile =
  | AggregatedResult['testResults'][number]
  | FormattedTestResults['testResults'][number]
type Allocate = (titles: readonly string[]) => TestIdentity
type AnyAssertion =
  | AggregatedResult['testResults'][number]['testResults'][number]
  | FormattedTestResults['testResults'][number]['assertionResults'][number]

function mapStatus(status: AnyAssertion['status']): TestStatus {
  switch (status) {
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'todo':
      return 'todo'
    // `pending` is what Jest 30 (jest-circus) reports for `it.skip`, `xit` and tests filtered out
    // by `.only` or `-t`. `skipped` and `disabled` are the legacy jasmine words.
    case 'pending':
    case 'skipped':
    case 'disabled':
    // `focused` is a file-level word in Jest 30 ("passed, but some tests did not run"); on a test
    // it can only mean the test was left out by a focus filter.
    case 'focused':
      return 'skipped'
    default: {
      const unexpected: never = status
      throw new HarnessError('HARNESS_UNKNOWN_STATUS', `unknown Jest test status: ${unexpected}`)
    }
  }
}

/** `failureDetails[i].matcherResult.name`, which `--json` carries but the types don't declare. */
function matcherName(details: unknown, index: number): string | undefined {
  if (!Array.isArray(details)) return undefined
  const detail: unknown = details[index]
  if (!isRecord(detail)) return undefined
  const result = detail.matcherResult
  if (!isRecord(result)) return undefined
  return typeof result.name === 'string' && result.name !== '' ? result.name : undefined
}

function convertAssertion(
  assertion: AnyAssertion,
  allocate: Allocate,
  conversion: Conversion,
): NormalizedTest {
  const details = prop(assertion, 'failureDetails')
  const passingAssertions = finiteNumber(prop(assertion, 'numPassingAsserts'))
  const invocations = finiteNumber(prop(assertion, 'invocations'))
  return assembleTest(assertion, allocate, conversion, {
    status: mapStatus(assertion.status),
    matcherOf: (index) => matcherName(details, index),
    extra: {
      ...(passingAssertions === undefined ? {} : { passingAssertions }),
      ...(invocations !== undefined && invocations > 1 ? { retries: invocations - 1 } : {}),
      ...(prop(assertion, 'failing') === true ? { expectedToFail: true } : {}),
    },
  })
}

function rawFile(file: JestFile, conversion: Conversion): RawFile {
  const convert = (assertion: AnyAssertion, allocate: Allocate): NormalizedTest =>
    convertAssertion(assertion, allocate, conversion)
  if ('testFilePath' in file) {
    // The reporter shape (`AggregatedResult`): the status is derived the way Jest's own
    // `formatTestResults` derives it.
    const execError = file.testExecError
    const status =
      execError || file.numFailingTests > 0 ? 'failed' : file.skipped ? 'skipped' : 'passed'
    const duration = finiteNumber(file.perfStats.end - file.perfStats.start)
    return {
      path: file.testFilePath,
      status,
      message: file.failureMessage ?? execError?.message ?? '',
      ...(duration === undefined ? {} : { durationMs: duration }),
      tests: (allocate) => file.testResults.map((a) => convert(a, allocate)),
    }
  }
  // The `--json` shape. `focused` means every test passed but some did not run.
  return jsonFile(file, file.status === 'focused' ? 'passed' : file.status, convert)
}

/**
 * Converts Jest's JSON to a `NormalizedRun`. Both shapes work: `--json` (`name`,
 * `assertionResults`) and the reporter's `AggregatedResult` (`testFilePath`, `testResults`).
 * A failed file with no tests becomes `crashed` with a `fileError`. Console output is not in either
 * shape, so `console` is absent.
 * @public
 */
export function convertJest(
  input: AggregatedResult | FormattedTestResults,
  opts: JestConvertOptions,
): NormalizedRun {
  const conversion = startConversion(opts)
  const files = input.testResults.map((file) => assembleFile(rawFile(file, conversion), conversion))
  const runExecError = 'runExecError' in input ? input.runExecError : undefined
  const runErrors = runExecError
    ? [errorOf(runExecError.stack ?? runExecError.message, conversion)]
    : []
  return runOf(
    {
      runner: 'jest',
      files,
      startTime: input.startTime,
      counters: countersOf(input.snapshot),
      runErrors,
      success: input.success,
    },
    opts,
  )
}
