// The result shapes' misuse cases: a function takes the shape Jest gives it and nothing else.
import type {
  AggregatedResult,
  AssertionResult,
  FileEvents,
  FormattedTestResults,
  Status,
  TestResult,
} from '@provino/dialect-jest/results'
import { formatJson, toTestResult } from '@provino/dialect-jest/results'
import type { FileResult } from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const aggregated: AggregatedResult
declare const file: TestResult
declare const fileResult: FileResult
declare const events: FileEvents

expectTypeOf(formatJson(aggregated)).toEqualTypeOf<FormattedTestResults>()
expectTypeOf<AssertionResult['status']>().toEqualTypeOf<Status>()

// A file's result is not the run's.
// @ts-expect-error `formatJson` formats the run's results, not one file's
formatJson(file)

// The core's `skip` is Jest's `pending`.
// @ts-expect-error 'skip' is not a Jest status
const skipped: Status = 'skip'

// The orchestrator's result is not the events the builder reads.
// @ts-expect-error `toTestResult` takes the collector's `FileEvents`, not a `FileResult`
toTestResult(fileResult, { locations: true, displayName: undefined })

expectTypeOf(
  toTestResult(events, { locations: true, displayName: undefined }),
).toEqualTypeOf<TestResult>()

export { skipped }
