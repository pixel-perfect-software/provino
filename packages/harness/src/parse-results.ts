import type { FormattedTestResults } from '@jest/test-result'
import type { JsonTestResults } from 'vitest/node'
import { HarnessError } from './errors.ts'
import { isRecord } from './internal/guards.ts'

// The guards check the envelope a converter walks: the run's totals and, for every file, its
// name, status text and assertion list. Fields inside an assertion are read defensively by the
// converters, because both runners write more than their types declare.

function isResultFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    typeof value.status === 'string' &&
    Array.isArray(value.assertionResults) &&
    value.assertionResults.every(
      (a) =>
        isRecord(a) &&
        typeof a.title === 'string' &&
        typeof a.status === 'string' &&
        Array.isArray(a.ancestorTitles),
    )
  )
}

function hasEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.startTime === 'number' &&
    typeof value.success === 'boolean' &&
    typeof value.numTotalTests === 'number' &&
    isRecord(value.snapshot) &&
    Array.isArray(value.testResults) &&
    value.testResults.every(isResultFile)
  )
}

function isJestResults(value: unknown): value is FormattedTestResults {
  return hasEnvelope(value) && typeof value.wasInterrupted === 'boolean'
}

function isVitestResults(value: unknown): value is JsonTestResults {
  return hasEnvelope(value) && typeof value.numTodoTests === 'number'
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
