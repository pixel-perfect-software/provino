// @provino/dialect-jest/results: Jest's result shapes and how the coordinator builds them from the
// run's events (D103): the `AggregatedResult` a `testResultsProcessor` and `--json` read.
export {
  type BuildOptions,
  type FileEvents,
  finishAggregated,
  flattenSerializedError,
  NO_TESTS_MESSAGE,
  type RunEnd,
  type TestRecord,
  toAssertionResult,
  toTestResult,
} from './build.ts'
export {
  createJestResults,
  type GlobalConfigLike,
  type JestResults,
  type JestResultsOptions,
  type ProjectConfigLike,
} from './collect.ts'
export {
  formatFileError,
  formatRetryError,
  formatTestFailures,
  type StackTraceConfig,
  type StackTraceOptions,
} from './failure-message.ts'
export { formatJson, serializeToJson } from './format-json.ts'
export {
  addResult,
  buildFailureTestResult,
  createEmptyTestResult,
  makeCollectedTestResult,
  makeEmptyAggregatedTestResult,
} from './helpers.ts'
export type {
  AggregatedResult,
  AssertionResult,
  ConsoleEntry,
  DisplayName,
  FormattedTestResult,
  FormattedTestResults,
  SerializableError,
  SnapshotSummary,
  Status,
  Test,
  TestContext,
  TestResult,
  TestResultsProcessor,
  UncheckedSnapshot,
} from './types.ts'
