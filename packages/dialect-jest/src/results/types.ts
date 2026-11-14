// Jest 30.5.2's result shapes, re-declared (D103) so the coordinator can build them without
// loading Jest's packages. Each cites the `@jest/test-result` 30.5.2 declaration it copies
// (`packages/jest-test-result/src/types.ts`, covered by THIRD_PARTY_NOTICES.md). A `@jest/test-result`
// devDependency checks them as an oracle (`helpers.test.ts`, `format-json.test.ts`). Where Jest has
// `any` or a class (`Error`, `ConsoleBuffer`, `ProjectConfig`) this has `unknown` or a parameter.

/**
 * A test's status (`AssertionResult['status']`). A skipped test is `pending`; `skipped` is a
 * file's flag, not a status.
 * @public
 */
export type Status = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled' | 'focused'

/**
 * One test's result (`@jest/types` `TestResult.AssertionResult`, with `startAt` and `wouldRun` as
 * `jest-circus` 30.5.2 fills them).
 * @public
 */
export interface AssertionResult {
  ancestorTitles: string[]
  duration?: number | null
  failing?: boolean
  failureDetails: unknown[]
  failureMessages: string[]
  fullName: string
  invocations?: number
  location?: { column: number; line: number } | null
  numPassingAsserts: number
  retryMessages?: string[]
  retryReasons?: string[]
  startAt?: number | null
  status: Status
  title: string
  /** Set by `--collectTests` on a test that a run would start. */
  wouldRun?: true
}

/**
 * A serialized error (`TestResult.SerializableError`).
 * @public
 */
export interface SerializableError {
  code?: unknown
  message: string
  stack: string | null | undefined
  type?: string
}

/**
 * A `console` call a file made (`@jest/console` `LogEntry`).
 * @public
 */
export interface ConsoleEntry {
  message: string
  origin: string
  type: string
}

/**
 * What `onTestCaseStart` gets (`Circus.TestCaseStartInfo`, `@jest/types`).
 * @public
 */
export interface TestCaseStartInfo {
  ancestorTitles: string[]
  fullName: string
  mode: 'skip' | 'only' | 'todo' | undefined
  title: string
  startedAt?: number | null
}

/**
 * The shape of Jest's `displayName` project option.
 * @public
 */
export interface DisplayName {
  name: string
  color: string
}

/**
 * One file's result (`TestResult`). `console`, `coverage`, `v8Coverage` and `memoryUsage` are what
 * Jest leaves out when it has none.
 * @public
 */
export interface TestResult {
  console?: ConsoleEntry[] | undefined
  coverage?: Record<string, unknown>
  displayName?: DisplayName | undefined
  failing?: boolean
  failureMessage?: string | null
  leaks: boolean
  memoryUsage?: number
  numFailingTests: number
  numPassingTests: number
  numPendingTests: number
  numTodoTests: number
  openHandles: Error[]
  perfStats: {
    end: number
    loadTestEnvironmentEnd: number
    loadTestEnvironmentStart: number
    runtime: number
    setupAfterEnvEnd: number
    setupAfterEnvStart: number
    setupFilesEnd: number
    setupFilesStart: number
    slow: boolean
    start: number
  }
  skipped: boolean
  snapshot: {
    added: number
    fileDeleted: boolean
    matched: number
    unchecked: number
    uncheckedKeys: string[]
    unmatched: number
    updated: number
  }
  testExecError?: SerializableError | undefined
  testFilePath: string
  testResults: AssertionResult[]
}

/**
 * The files that still had obsolete snapshots (`UncheckedSnapshot`).
 * @public
 */
export interface UncheckedSnapshot {
  filePath: string
  keys: string[]
}

/**
 * The run's snapshot totals (`SnapshotSummary`).
 * @public
 */
export interface SnapshotSummary {
  added: number
  didUpdate: boolean
  failure: boolean
  filesAdded: number
  filesRemoved: number
  filesRemovedList: string[]
  filesUnmatched: number
  filesUpdated: number
  matched: number
  total: number
  unchecked: number
  uncheckedKeysByFile: UncheckedSnapshot[]
  unmatched: number
  updated: number
}

/**
 * The run's results (`AggregatedResult`). `coverageMap` is set only once the reports are written
 * (Jest's CoverageReporter sets it in its `onRunComplete`), so a reporter before it never sees one.
 * @public
 */
export interface AggregatedResult {
  numFailedTests: number
  numFailedTestSuites: number
  numPassedTests: number
  numPassedTestSuites: number
  numPendingTests: number
  numTodoTests: number
  numPendingTestSuites: number
  numRuntimeErrorTestSuites: number
  numTotalTests: number
  numTotalTestSuites: number
  openHandles: Error[]
  snapshot: SnapshotSummary
  startTime: number
  success: boolean
  testResults: TestResult[]
  wasInterrupted: boolean
  runExecError?: SerializableError
  /** An `istanbul-lib-coverage` `CoverageMap` of the run's coverage, when it collected some. */
  coverageMap?: unknown
}

/**
 * What a `testResultsProcessor` module exports (`TestResultsProcessor`).
 * @public
 */
export type TestResultsProcessor = (
  results: AggregatedResult,
) => AggregatedResult | Promise<AggregatedResult>

/**
 * A file's result as `--json` prints it (`FormattedTestResult`).
 * @public
 */
export interface FormattedTestResult {
  message: string
  name: string
  summary: string
  status: 'failed' | 'passed' | 'skipped' | 'focused'
  startTime: number
  endTime: number
  coverage: unknown
  assertionResults: AssertionResult[]
}

/**
 * The run's results as `--json` prints them (`FormattedTestResults`, which is the aggregate with
 * its files formatted; a processor's own keys stay).
 * @public
 */
export interface FormattedTestResults extends Omit<AggregatedResult, 'testResults'> {
  testResults: FormattedTestResult[]
}

/**
 * A test file of the run (`Test`): where it is and the project it belongs to. Jest's context also
 * holds the haste map and resolver; here it is the project's config alone.
 * @public
 */
export interface Test<Config = unknown> {
  context: TestContext<Config>
  duration?: number
  path: string
}

/**
 * A project's context (`TestContext`), reduced to its `config`.
 * @public
 */
export interface TestContext<Config = unknown> {
  config: Config
}
