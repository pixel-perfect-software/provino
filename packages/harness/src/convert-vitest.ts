import type { NormalizedRun, TestStatus } from '@provino/types'
import type { JsonTestResults } from 'vitest/node'
import type { VitestConvertOptions } from './convert-options.ts'
import { HarnessError } from './errors.ts'
import {
  assembleFile,
  assembleTest,
  attachConsole,
  countersOf,
  jsonFile,
  runOf,
  startConversion,
} from './internal/convert.ts'

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

/**
 * Converts Vitest's `--reporter=json` output to a `NormalizedRun`. Vitest's `pending` becomes
 * `notRun`. A failed file with no tests becomes `crashed` with a `fileError`. The JSON has no
 * matcher names or assertion counts, so those fields are absent, and no console output: that comes
 * from the sidecar reporter through `opts.console`, per test where Vitest names one. A failure's text
 * is `e.stack || e.message`, which is nothing at all for `throw { status: 404 }`, and JSON makes
 * that a null.
 * @public
 */
export function convertVitest(input: JsonTestResults, opts: VitestConvertOptions): NormalizedRun {
  const conversion = startConversion(opts)
  const files = attachConsole(
    input.testResults.map((file) =>
      assembleFile(
        jsonFile(file, file.status, (assertion, allocate) =>
          assembleTest(assertion, allocate, conversion, { status: mapStatus(assertion.status) }),
        ),
        conversion,
      ),
    ),
    conversion,
  )
  return runOf(
    {
      runner: 'vitest',
      files,
      startTime: input.startTime,
      counters: countersOf(input.snapshot),
      runErrors: [],
      success: input.success,
    },
    opts,
  )
}
