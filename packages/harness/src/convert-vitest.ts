import type {
  NormalizedError,
  NormalizedRun,
  NormalizedTest,
  SnapshotCounters,
  TestIdentity,
  TestStatus,
} from '@provino/types'
import type { JsonTestResults } from 'vitest/node'
import type { VitestConvertOptions } from './convert-options.ts'
import { HarnessError } from './errors.ts'
import { assembleFile, contextOf, type RawFile, runOf, skipReasonOf } from './internal/convert.ts'
import { finiteNumber } from './internal/guards.ts'
import { normalizeError } from './normalize.ts'

type VitestFile = JsonTestResults['testResults'][number]
type VitestAssertion = VitestFile['assertionResults'][number]

function mapStatus(status: VitestAssertion['status']): TestStatus {
  switch (status) {
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'todo':
      return 'todo'
    case 'skipped':
    case 'disabled':
      return 'skipped'
    // Vitest's `pending` means the test was collected but never started.
    case 'pending':
      return 'notRun'
    default: {
      const unexpected: never = status
      throw new HarnessError('HARNESS_UNKNOWN_STATUS', `unknown Vitest test status: ${unexpected}`)
    }
  }
}

function convertAssertion(
  assertion: VitestAssertion,
  allocate: (titles: readonly string[]) => TestIdentity,
  options: VitestConvertOptions,
): NormalizedTest {
  const status = mapStatus(assertion.status)
  const ctx = contextOf(options)
  // The JSON has the message text only: no matcher name, so `matcher` stays absent.
  const errors: NormalizedError[] = (assertion.failureMessages ?? []).map((message) =>
    normalizeError(message, ctx, undefined, options.fired),
  )
  const skipReason = skipReasonOf(status)
  const duration = finiteNumber(assertion.duration)
  const location = assertion.location
  return {
    id: allocate([...assertion.ancestorTitles, assertion.title]),
    status,
    ...(skipReason === undefined ? {} : { skipReason }),
    errors,
    ...(duration === undefined ? {} : { durationMs: duration }),
    ...(location ? { location: { line: location.line, column: location.column } } : {}),
  }
}

function rawFile(file: VitestFile, options: VitestConvertOptions): RawFile {
  const duration = finiteNumber(file.endTime - file.startTime)
  return {
    path: file.name,
    status: file.status,
    message: file.message,
    hasExecError: false,
    ...(duration === undefined ? {} : { durationMs: duration }),
    tests: (allocate) => file.assertionResults.map((a) => convertAssertion(a, allocate, options)),
  }
}

function countersOf(input: JsonTestResults): SnapshotCounters {
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
 * Converts Vitest's `--reporter=json` output to a `NormalizedRun`. Vitest's `pending` becomes
 * `notRun`. A failed file with no tests becomes `crashed` with a `fileError`. The JSON has no
 * console output, matcher names or assertion counts, so those fields are absent.
 * @public
 */
export function convertVitest(input: JsonTestResults, opts: VitestConvertOptions): NormalizedRun {
  return runOf(
    {
      runner: 'vitest',
      files: input.testResults.map((file) => assembleFile(rawFile(file, opts), opts)),
      startTime: input.startTime,
      counters: countersOf(input),
      runErrors: [],
      success: input.success,
    },
    opts,
  )
}
