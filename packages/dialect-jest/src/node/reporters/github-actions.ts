// Jest's `github-actions` reporter (jest-reporters 30.5.2 `GitHubActionsReporter.ts`), as a Jest
// reporter class the host runs beside the custom ones: one `::error` or `::warning` annotation per
// failure and retry, and, once the last file has reported, a group with the failure text of each
// failed file. Built is the default (`silent: true`); the result tree `silent: false` adds is not.
import type {
  AggregatedResult,
  ProjectConfigLike,
  Test,
  TestResult,
} from '@provino/dialect-jest/results'
import { hideProvinoFrames } from '../../results/failure-message.ts'
import type { JestReporterClass, JestReporterInstance } from './host.ts'

type MessageUtil = typeof import('jest-message-util')

const TITLE_SEPARATOR = ' › '

// `stripVTControlCharacters` of Jest's `#createAnnotation` is `node:util`'s.
import { stripVTControlCharacters } from 'node:util'

let loaded: Promise<MessageUtil> | undefined
function messageUtil(): Promise<MessageUtil> {
  loaded ??= import('jest-message-util')
  return loaded
}

/** `BaseReporter#log`: a line on stderr. */
function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * The `github-actions` reporter of Jest 30.5.2 (`silent` defaults to `true`, as there).
 * @public
 */
export const jestGitHubActionsReporter: JestReporterClass = class JestGitHubActionsReporter
  implements JestReporterInstance
{
  async onTestResult(
    test: Test,
    testResult: TestResult,
    aggregated: AggregatedResult,
  ): Promise<void> {
    await this.#annotate(test, testResult)
    if (this.#isLastTestSuite(aggregated)) await this.#printFailedTestLogs(test, aggregated)
  }

  getLastError(): undefined {
    return undefined
  }

  async #annotate(test: Test, { testResults }: TestResult): Promise<void> {
    const config = test.context.config as ProjectConfigLike
    for (const result of testResults) {
      const title = [...result.ancestorTitles, result.title].join(TITLE_SEPARATOR)
      if (result.retryReasons !== undefined) {
        for (const [index, reason] of result.retryReasons.entries()) {
          await this.#annotation({
            ...(await this.#details(reason, config)),
            title: `RETRY ${index + 1}: ${title}`,
            type: 'warning',
          })
        }
      }
      for (const failure of result.failureMessages) {
        await this.#annotation({ ...(await this.#details(failure, config)), title, type: 'error' })
      }
    }
  }

  async #details(
    failureMessage: string,
    config: ProjectConfigLike,
  ): Promise<{ file: string | undefined; line: number | undefined; message: string }> {
    const util = await messageUtil()
    // Jest's own frames fall out in `getStackTraceLines`; ours do the same (D104).
    const { message, stack } = util.separateMessageFromStack(hideProvinoFrames(failureMessage))
    const stackLines = util.getStackTraceLines(stack)
    const topFrame = util.getTopFrame(stackLines)
    const normalized = stackLines.map((line) =>
      util.formatPath(line, config as unknown as Parameters<MessageUtil['formatPath']>[1]),
    )
    return {
      file: topFrame?.file,
      line: topFrame?.line,
      message: [message, ...normalized].join('\n'),
    }
  }

  async #annotation(options: {
    file: string | undefined
    line: number | undefined
    message: string
    title: string
    type: 'error' | 'warning'
  }): Promise<void> {
    // actions/toolkit `command.ts`' escaping, as Jest copies it.
    const message = stripVTControlCharacters(
      options.message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'),
    )
    log(
      `\n::${options.type} file=${options.file},line=${options.line},title=${options.title}::${message}`,
    )
  }

  #isLastTestSuite(results: AggregatedResult): boolean {
    const computed = results.numPassedTestSuites + results.numFailedTestSuites
    if (computed < results.numTotalTestSuites) return false
    if (computed === results.numTotalTestSuites) return true
    throw new Error(
      `Sum(${computed}) of passed (${results.numPassedTestSuites}) and failed (${results.numFailedTestSuites}) test suites is greater than the total number of test suites (${results.numTotalTestSuites}). Please report the bug at https://github.com/jestjs/jest/issues`,
    )
  }

  async #printFailedTestLogs(context: Test, results: AggregatedResult): Promise<void> {
    const rootDir = (context.context.config as ProjectConfigLike).rootDir
    let written = false
    for (const result of results.testResults) {
      const testDir = result.testFilePath.replace(rootDir, '').slice(1)
      if (result.failureMessage) {
        if (!written) {
          log('')
          written = true
        }
        log(`::group::Errors thrown in ${testDir}`)
        log(result.failureMessage)
        log('::endgroup::')
      }
    }
  }
}
