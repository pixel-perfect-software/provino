// A runner's JSON, as either reference runner writes it, to a NormalizedRun. Apart from
// `internal/convert.ts`, which the converters themselves import.
import type { NormalizedRun } from '@provino/types'
import { convertJest } from '../convert-jest.ts'
import type { ConvertOptions } from '../convert-options.ts'
import { convertVitest } from '../convert-vitest.ts'
import type { FixtureRunner } from '../fixture.ts'
import { parseJestJson, parseVitestJson } from '../parse-results.ts'

/**
 * Parses the JSON Jest (`--json`) or Vitest (`--reporter=json`) wrote and converts it.
 * `HARNESS_RESULT_INVALID` when the text isn't that runner's JSON.
 * @internal
 */
export function convertRunnerJson(
  runner: FixtureRunner,
  text: string,
  source: string,
  options: ConvertOptions,
): NormalizedRun {
  return runner === 'jest'
    ? convertJest(parseJestJson(text, source), options)
    : convertVitest(parseVitestJson(text, source), options)
}
