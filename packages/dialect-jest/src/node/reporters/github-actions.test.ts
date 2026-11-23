// The `silent: false` output of the `github-actions` reporter (jest-reporters 30.5.2
// `GitHubActionsReporter.ts` L176-L459) on cases the one recorded project can't hold: a status
// Jest leaves without a mark, the platform's marks, and a buffer with no entries. The text of a
// whole run is `cli/github-actions-not-silent`, held by `provino`'s `jest-github-actions.test.ts`;
// colour against chalk is `provino`'s `jest-github-actions-colour.test.ts`.
import assert from 'node:assert/strict'
import type { AggregatedResult, TestResult } from '@provino/dialect-jest/results'
import { afterAll, afterEach, describe, it } from 'provino'
import { createJestGitHubActionsReporter, jestResultIcons } from './github-actions.ts'

const written: string[] = []
const originalWrite = process.stderr.write
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  written.push(String(chunk))
  return true
}) as typeof process.stderr.write
afterAll(() => {
  process.stderr.write = originalWrite
})
afterEach(() => {
  written.length = 0
})

function result(statuses: readonly string[], consoleEntries?: TestResult['console']): TestResult {
  return {
    console: consoleEntries,
    failureMessage: null,
    perfStats: { runtime: 5, slow: false },
    testFilePath: '/r/a.test.ts',
    testResults: statuses.map((status, index) => ({
      ancestorTitles: [],
      duration: 2,
      failureMessages: [],
      status,
      title: `t${index}`,
    })),
  } as unknown as TestResult
}

async function run(
  testResult: TestResult,
  options: { readonly platform?: string } = {},
): Promise<string[]> {
  const Reporter = createJestGitHubActionsReporter(options)
  const reporter = new Reporter({ verbose: false } as never, { silent: false }, {} as never)
  const test = { context: { config: { rootDir: '/r' } } } as never
  const aggregated = {
    numFailedTestSuites: 0,
    numPassedTestSuites: 0,
    numTotalTestSuites: 2,
    testResults: [],
  } as unknown as AggregatedResult
  await reporter.onTestResult?.(test, testResult, aggregated)
  return written.join('').split('\n')
}

describe('the github-actions result tree', () => {
  it('prints Jest’s literal `undefined` for a status with no mark (L387-L405)', async () => {
    const lines = await run(result(['disabled', 'focused']))
    assert.ok(lines.includes('  undefined t0 (2 ms)'))
    assert.ok(lines.includes('  undefined t1 (2 ms)'))
  })

  it('uses the platform’s marks, injected', async () => {
    assert.deepEqual(jestResultIcons('win32'), {
      failed: '×',
      pending: '○',
      success: '√',
      todo: '✎',
    })
    assert.equal(jestResultIcons('linux').success, '✓')
    const lines = await run(result(['passed', 'failed']), { platform: 'win32' })
    // A failed file's lines are not grouped, so one level deeper.
    assert.ok(lines.includes('    √ t0 (2 ms)'))
    assert.ok(lines.includes('    × t1 (2 ms)'))
  })

  it('logs no console block for an empty buffer', async () => {
    const lines = await run(result(['passed'], []))
    assert.deepEqual(lines, ['::group::PASS a.test.ts (5 ms)', '  ✓ t0 (2 ms)', '::endgroup::', ''])
  })
})
