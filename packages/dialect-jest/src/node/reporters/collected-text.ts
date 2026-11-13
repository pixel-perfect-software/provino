// What `--collectTests` prints without `--json`: jest-core 30.5.2 `runJest.ts` `printCollectedResults`
// (L104-L121), `printCollectedTestTree` (L43-L71) and `printCollectedTestSummary` (L73-L102), with
// `VerboseReporter.groupTestsBySuites` (jest-reporters VerboseReporter.ts L54-L73) for the tree.
import type { AggregatedResult, AssertionResult } from '@provino/dialect-jest/results'

/**
 * The colours the text uses; `@provino/reporters`' `Style` has them all.
 * @public
 */
export interface CollectedTextStyle {
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  magenta(text: string): string
}

interface Suite {
  readonly suites: Suite[]
  readonly tests: AssertionResult[]
  readonly title: string
}

/** `VerboseReporter.groupTestsBySuites`: the tests nested by their ancestor titles. */
function groupTestsBySuites(testResults: readonly AssertionResult[]): Suite {
  const root: Suite = { suites: [], tests: [], title: '' }
  for (const testResult of testResults) {
    let target = root
    for (const title of testResult.ancestorTitles) {
      let matching = target.suites.find((suite) => suite.title === title)
      if (matching === undefined) {
        matching = { suites: [], tests: [], title }
        target.suites.push(matching)
      }
      target = matching
    }
    target.tests.push(testResult)
  }
  return root
}

/** `printCollectedTestTree`: the tests of one file, each title under its suites. */
function tree(testResults: readonly AssertionResult[], style: CollectedTextStyle): string {
  const annotate = (test: AssertionResult): string => {
    if (test.status === 'todo') return style.dim(' [todo]')
    if (test.status === 'pending') return style.dim(' [skipped]')
    return ''
  }
  let out = ''
  const printSuite = (suite: Suite, indent: number): void => {
    if (suite.title) out += `${'  '.repeat(indent)}${suite.title}\n`
    for (const test of suite.tests) {
      out += `${'  '.repeat(indent + 1)}${test.title}${annotate(test)}\n`
    }
    for (const child of suite.suites) printSuite(child, indent + 1)
  }
  printSuite(groupTestsBySuites(testResults), 0)
  return out
}

/**
 * The text of a collect-only run: each file's tree (a file that failed to load, with its error),
 * then the summary.
 * @public
 */
export function jestCollectedText(results: AggregatedResult, style: CollectedTextStyle): string {
  let out = ''
  for (const testResult of results.testResults) {
    if (testResult.testExecError) {
      out += `${style.red(testResult.testFilePath)}\n${
        testResult.failureMessage ?? testResult.testExecError.message
      }\n`
    } else if (testResult.testResults.length > 0) {
      out += `${testResult.testFilePath}\n${tree(testResult.testResults, style)}`
    }
  }
  const line = [`${style.bold(String(results.numTotalTests))} total`]
  if (results.numPassedTests > 0) line.push(style.green(`${results.numPassedTests} runnable`))
  if (results.numPendingTests > 0) line.push(style.yellow(`${results.numPendingTests} skipped`))
  if (results.numTodoTests > 0) line.push(style.magenta(`${results.numTodoTests} todo`))
  out += `\n${style.bold('Test suites:')} ${results.numTotalTestSuites}\n`
  out += `${style.bold('Tests:')}       ${line.join(', ')}\n`
  if (results.numRuntimeErrorTestSuites > 0) {
    out += style.red(
      style.bold(
        `\n${results.numRuntimeErrorTestSuites} test suite(s) failed to load and could not be collected.\n`,
      ),
    )
  }
  return out
}
