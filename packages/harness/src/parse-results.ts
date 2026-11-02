import type { FormattedTestResults } from '@jest/test-result'
import type { JsonTestResults } from 'vitest/node'
import { HarnessError } from './errors.ts'
import { isRecord } from './internal/guards.ts'

// The guards check the envelope a converter walks: the run's totals and, for every file, its
// name, status text and assertion list. Fields inside an assertion are read defensively by the
// converters, because both runners write more than their types declare.

// A file's status, as each runner's types declare it. Jest 30's `--json` adds `focused` and
// `skipped`; Vitest's JSON reporter writes only `passed` or `failed`.
const JEST_FILE_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'skipped', 'focused'])
const VITEST_FILE_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed'])

// Fields only Jest's `--json` writes. Jest 30.5 also writes `numTodoTests`, so that one can't tell
// the runners apart.
const JEST_ONLY_FIELDS: readonly string[] = ['wasInterrupted', 'numRuntimeErrorTestSuites']

/**
 * `failureMessages` is a list of strings; Vitest writes `e.stack || e.message`, so a thrown
 * object with neither is a null in the list, and the whole field can be null or missing.
 */
function isFailureMessages(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.every((m) => m === null || typeof m === 'string'))
  )
}

function isResultFile(value: unknown, statuses: ReadonlySet<string>): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    typeof value.status === 'string' &&
    statuses.has(value.status) &&
    Array.isArray(value.assertionResults) &&
    value.assertionResults.every(
      (a) =>
        isRecord(a) &&
        typeof a.title === 'string' &&
        typeof a.status === 'string' &&
        Array.isArray(a.ancestorTitles) &&
        isFailureMessages(a.failureMessages),
    )
  )
}

function hasEnvelope(
  value: unknown,
  statuses: ReadonlySet<string>,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.startTime === 'number' &&
    typeof value.success === 'boolean' &&
    typeof value.numTotalTests === 'number' &&
    isRecord(value.snapshot) &&
    Array.isArray(value.testResults) &&
    value.testResults.every((file) => isResultFile(file, statuses))
  )
}

function isJestResults(value: unknown): value is FormattedTestResults {
  return hasEnvelope(value, JEST_FILE_STATUSES) && typeof value.wasInterrupted === 'boolean'
}

function isVitestResults(value: unknown): value is JsonTestResults {
  return (
    hasEnvelope(value, VITEST_FILE_STATUSES) &&
    typeof value.numTodoTests === 'number' &&
    JEST_ONLY_FIELDS.every((field) => !(field in value))
  )
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new HarnessError('HARNESS_RESULT_INVALID', `${source} is not valid JSON`, {
      path: source,
      cause,
    })
  }
}

/**
 * Parses the file `jest --json --outputFile=…` writes. Checks the envelope, not every field.
 * @public
 */
export function parseJestJson(text: string, source: string = 'Jest output'): FormattedTestResults {
  const value = parseJson(text, source)
  if (!isJestResults(value)) {
    throw new HarnessError('HARNESS_RESULT_INVALID', `${source} is not Jest's --json output`, {
      path: source,
    })
  }
  return value
}

/**
 * Parses the file `vitest --reporter=json --outputFile=…` writes. Checks the envelope, not every
 * field.
 * @public
 */
export function parseVitestJson(text: string, source: string = 'Vitest output'): JsonTestResults {
  const value = parseJson(text, source)
  if (!isVitestResults(value)) {
    throw new HarnessError('HARNESS_RESULT_INVALID', `${source} is not Vitest's JSON report`, {
      path: source,
    })
  }
  return value
}
