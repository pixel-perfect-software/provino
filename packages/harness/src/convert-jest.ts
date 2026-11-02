import type { AggregatedResult, FormattedTestResults } from '@jest/test-result'
import type {
  NormalizedError,
  NormalizedRun,
  NormalizedTest,
  SnapshotCounters,
  TestIdentity,
  TestStatus,
} from '@provino/types'
import type { JestConvertOptions } from './convert-options.ts'
import { HarnessError } from './errors.ts'
import {
  assembleFile,
  contextOf,
  NO_ERROR_MESSAGE,
  type RawFile,
  runOf,
  skipReasonOf,
} from './internal/convert.ts'
import { finiteNumber, isRecord, prop } from './internal/guards.ts'
import { normalizeError } from './normalize.ts'

type JestFile =
  | AggregatedResult['testResults'][number]
  | FormattedTestResults['testResults'][number]
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
  allocate: (titles: readonly string[]) => TestIdentity,
  options: JestConvertOptions,
): NormalizedTest {
  const status = mapStatus(assertion.status)
  const ctx = contextOf(options)
  // Jest's types say strings; a thrown non-Error can leave a null in the JSON.
  const messages: readonly (string | null)[] = assertion.failureMessages ?? []
  const details = prop(assertion, 'failureDetails')
  const errors: NormalizedError[] = messages.map((message, index) =>
    normalizeError(message ?? NO_ERROR_MESSAGE, ctx, matcherName(details, index), options.fired),
  )
  const passingAssertions = finiteNumber(prop(assertion, 'numPassingAsserts'))
  const invocations = finiteNumber(prop(assertion, 'invocations'))
  const skipReason = skipReasonOf(status)
  const location = assertion.location
  const duration = finiteNumber(assertion.duration)
  return {
    id: allocate([...assertion.ancestorTitles, assertion.title]),
    status,
    ...(skipReason === undefined ? {} : { skipReason }),
    errors,
    ...(passingAssertions === undefined ? {} : { passingAssertions }),
    ...(invocations !== undefined && invocations > 1 ? { retries: invocations - 1 } : {}),
    ...(duration === undefined ? {} : { durationMs: duration }),
    ...(location ? { location: { line: location.line, column: location.column } } : {}),
    ...(prop(assertion, 'failing') === true ? { expectedToFail: true } : {}),
  }
}

function rawFile(file: JestFile, options: JestConvertOptions): RawFile {
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
      tests: (allocate) => file.testResults.map((a) => convertAssertion(a, allocate, options)),
    }
  }
  // The `--json` shape. `focused` means every test passed but some did not run.
  const duration = finiteNumber(file.endTime - file.startTime)
  return {
    path: file.name,
    status: file.status === 'focused' ? 'passed' : file.status,
    message: file.message,
    ...(duration === undefined ? {} : { durationMs: duration }),
    tests: (allocate) => file.assertionResults.map((a) => convertAssertion(a, allocate, options)),
  }
}

function countersOf(input: AggregatedResult | FormattedTestResults): SnapshotCounters {
  const s = input.snapshot
  return {
    added: s.added,
    matched: s.matched,
    unmatched: s.unmatched,
    updated: s.updated,
    unchecked: s.unchecked,
    total: s.total,
    filesAdded: s.filesAdded,
    filesRemoved: s.filesRemoved,
    filesUnmatched: s.filesUnmatched,
    filesUpdated: s.filesUpdated,
  }
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
  const files = input.testResults.map((file) => assembleFile(rawFile(file, opts), opts))
  const runExecError = 'runExecError' in input ? input.runExecError : undefined
  const runErrors = runExecError
    ? [
        normalizeError(
          runExecError.stack ?? runExecError.message,
          contextOf(opts),
          undefined,
          opts.fired,
        ),
      ]
    : []
  return runOf(
    {
      runner: 'jest',
      files,
      startTime: input.startTime,
      counters: countersOf(input),
      runErrors,
      success: input.success,
    },
    opts,
  )
}
