// `github-actions` with `silent: false` and colour on (B23d A4, DV90): the result tree's marks, the
// PASS badge and a multi-line console entry against chalk 4's own output (the oracle, resolved
// through jest-message-util's install; never a dependency of the source), with the colours Provino's
// `createStyle` builds from the run's colour decision.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { afterEach, describe, it, mock } from 'node:test'
import { createJestGitHubActionsReporter } from '@provino/dialect-jest/node'
import type { AggregatedResult, TestResult } from '@provino/dialect-jest/results'
import { createStyle } from 'provino/reporters'

type Chalk = {
  Instance: new (options: {
    level: number
  }) => {
    dim(text: string): string
    yellow(text: string): string
    red(text: string): string
    green(text: string): string
    bold: { green: { inverse(text: string): string } }
  }
}

function chalkOracle(): InstanceType<Chalk['Instance']> {
  const here = createRequire(import.meta.url)
  const dialect = createRequire(here.resolve('@provino/dialect-jest/node'))
  const messageUtil = createRequire(dialect.resolve('jest-message-util'))
  const chalk = messageUtil('chalk') as Chalk
  return new chalk.Instance({ level: 1 })
}

const written: string[] = []
mock.method(process.stderr, 'write', (chunk: string | Uint8Array): boolean => {
  written.push(String(chunk))
  return true
})
afterEach(() => {
  written.length = 0
})

describe('the github-actions result tree with colour', () => {
  it('colours the badge, the mark and a multi-line warn as chalk does', async () => {
    const chalk = chalkOracle()
    const Reporter = createJestGitHubActionsReporter({ style: createStyle(true) })
    const reporter = new Reporter({ verbose: false } as never, { silent: false }, {} as never)
    const testResult = {
      console: [{ type: 'warn', message: 'first\nsecond', origin: '' }],
      failureMessage: null,
      perfStats: { runtime: 5, slow: false },
      testFilePath: '/r/a.test.ts',
      testResults: [
        { ancestorTitles: [], duration: 2, failureMessages: [], status: 'passed', title: 'ok' },
      ],
    } as unknown as TestResult
    const aggregated = {
      numFailedTestSuites: 0,
      numPassedTestSuites: 0,
      numTotalTestSuites: 2,
      testResults: [],
    } as unknown as AggregatedResult
    await reporter.onTestResult?.(
      { context: { config: { rootDir: '/r' } } } as never,
      testResult,
      aggregated,
    )
    const expected = [
      `::group::${chalk.bold.green.inverse('PASS')} a.test.ts (5 ms)`,
      `    ${chalk.dim(chalk.yellow('console.warn'))}`,
      chalk.yellow('      first\n      second'),
      // The empty trace is dimmed to nothing; `getConsoleOutput` ends with one newline.
      chalk.dim(''),
      `  ${chalk.green('✓')} ok (2 ms)`,
      '::endgroup::',
      '',
    ].join('\n')
    assert.equal(written.join(''), expected)
  })
})
