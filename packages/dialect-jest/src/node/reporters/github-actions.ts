// Jest's `github-actions` reporter (jest-reporters 30.5.2 `GitHubActionsReporter.ts`), as a Jest
// reporter class the host runs beside the custom ones: one `::error` or `::warning` annotation per
// failure and retry, and, once the last file has reported, a group with the failure text of each
// failed file. `silent: false` (`GitHubActionsReporter#printFullResult`, L176-L459) adds, per file,
// the result tree in `::group::` blocks and the file's console output; the default is
// `silent: true`, as there.
import { stripVTControlCharacters, styleText } from 'node:util'
import type {
  AggregatedResult,
  AssertionResult,
  ProjectConfigLike,
  Status,
  Test,
  TestResult,
} from '@provino/dialect-jest/results'
import { hideProvinoFrames } from '../../results/failure-message.ts'
import { jestConsoleTrace } from './console-trace.ts'
import type { JestReporterClass, JestReporterInstance } from './host.ts'

type MessageUtil = typeof import('jest-message-util')

const TITLE_SEPARATOR = ' › '

let loaded: Promise<MessageUtil> | undefined
function messageUtil(): Promise<MessageUtil> {
  loaded ??= import('jest-message-util')
  return loaded
}

/** `jest-util`'s `specialChars.ICONS` (`specialChars.ts`), as the result tree prints them. */
const ICONS = { failed: '\u2715', pending: '\u25CB', success: '\u2713', todo: '\u270E' }

type Format = Parameters<typeof styleText>[0]

/** chalk's styles: `styleText` honours `NO_COLOR`, `FORCE_COLOR` and the terminal as chalk does. */
function paint(format: Format, text: string): string {
  return styleText(format, text)
}

/** What the reporter reads of the global config. */
interface GlobalConfigLike {
  readonly noStackTrace?: boolean
  readonly verbose?: boolean | undefined
}

/** What it reads of a project's config. */
type ProjectConfig = ProjectConfigLike & {
  readonly rootDir: string
  readonly verbose?: boolean | undefined
}

/** `PerformanceInfo` (L36-L41): the `perfStats` fields the tree header reads. */
interface PerformanceInfo {
  readonly runtime: number
  readonly slow: boolean
}

/** `ResultTreeLeaf` and `ResultTreeNode` (L43-L56). */
interface ResultTreeLeaf {
  readonly name: string
  readonly status: Status
  readonly duration: number
  readonly children: readonly never[]
}
interface ResultTreeNode {
  readonly name: string
  passed: boolean
  readonly children: Array<ResultTreeNode | ResultTreeLeaf>
}
interface ResultTree {
  readonly children: Array<ResultTreeNode | ResultTreeLeaf>
  readonly name: string
  passed: boolean
  readonly performanceInfo: PerformanceInfo
}

/** `arrayEqual` (L194-L205). */
function arrayEqual(a1: readonly string[], a2: readonly string[]): boolean {
  if (a1.length !== a2.length) return false
  for (const [index, element] of a1.entries()) if (element !== a2[index]) return false
  return true
}

/** `arrayChild` (L207-L218). */
function arrayChild(a1: readonly string[], a2: readonly string[]): boolean {
  if (a1.length - a2.length !== 1) return false
  for (const [index, element] of a2.entries()) if (element !== a1[index]) return false
  return true
}

/** `getResultTree` (L220-L262). */
function getResultTree(
  suiteResult: readonly AssertionResult[],
  testPath: string,
  suitePerf: PerformanceInfo,
): ResultTree {
  const root: ResultTree = {
    children: [],
    name: testPath,
    passed: true,
    performanceInfo: suitePerf,
  }
  const branches: string[][] = []
  for (const element of suiteResult) {
    if (element.ancestorTitles.length === 0) {
      if (element.status === 'failed') root.passed = false
      const duration = element.duration || 1
      root.children.push({ children: [], duration, name: element.title, status: element.status })
    } else {
      const head = element.ancestorTitles.slice(0, 1)
      if (!branches.some((branch) => arrayEqual(branch, head))) branches.push(head)
    }
  }
  for (const element of branches) {
    const newChild = getResultChildren(suiteResult, element)
    if (!newChild.passed) root.passed = false
    root.children.push(newChild)
  }
  return root
}

/** `getResultChildren` (L264-L328). */
function getResultChildren(
  suiteResult: readonly AssertionResult[],
  ancestors: readonly string[],
): ResultTreeNode {
  const node: ResultTreeNode = { children: [], name: ancestors.at(-1) as string, passed: true }
  const branches: string[][] = []
  for (const element of suiteResult) {
    let duration = element.duration
    if (!duration || Number.isNaN(duration)) duration = 1
    if (arrayEqual(element.ancestorTitles, ancestors)) {
      if (element.status === 'failed') node.passed = false
      node.children.push({ children: [], duration, name: element.title, status: element.status })
    } else if (arrayChild(element.ancestorTitles.slice(0, ancestors.length + 1), ancestors)) {
      const next = element.ancestorTitles.slice(0, ancestors.length + 1)
      if (!branches.some((branch) => arrayEqual(branch, next))) branches.push(next)
    }
  }
  for (const element of branches) {
    const newChild = getResultChildren(suiteResult, element)
    if (!newChild.passed) node.passed = false
    node.children.push(newChild)
  }
  return node
}

/** `getConsoleOutput` (jest-console 30.5.2 `getConsoleOutput.ts` L17-L60). */
function consoleOutput(
  entries: NonNullable<TestResult['console']>,
  config: ProjectConfig,
  globalConfig: GlobalConfigLike,
): string {
  const titleIndent = globalConfig.verbose === true ? '  ' : '    '
  const consoleIndent = `${titleIndent}  `
  let output = ''
  for (const { type, message: raw, origin } of entries) {
    let message = raw
      .split(/\n/)
      .map((line) => consoleIndent + line)
      .join('\n')
    let typeMessage = `console.${type}`
    if (type === 'warn') {
      message = paint('yellow', message)
      typeMessage = paint('yellow', typeMessage)
    } else if (type === 'error') {
      message = paint('red', message)
      typeMessage = paint('red', typeMessage)
    }
    const trace = jestConsoleTrace(origin, type, config, globalConfig)
    output += `${titleIndent}${paint('dim', typeMessage)}\n${message.trimEnd()}\n${paint('dim', trace.trimEnd())}\n\n`
  }
  return `${output.trimEnd()}\n`
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
  readonly #globalConfig: GlobalConfigLike
  readonly #silent: boolean

  constructor(globalConfig: GlobalConfigLike, reporterOptions: { silent?: unknown } = {}) {
    this.#globalConfig = globalConfig
    // The constructor, L58-L62.
    this.#silent = typeof reporterOptions.silent === 'boolean' ? reporterOptions.silent : true
  }

  async onTestResult(
    test: Test,
    testResult: TestResult,
    aggregated: AggregatedResult,
  ): Promise<void> {
    await this.#annotate(test, testResult)
    if (!this.#silent) this.#printFullResult(test, testResult)
    if (this.#isLastTestSuite(aggregated)) {
      this.#printFailedTestLogs(test, testResult.console, aggregated)
    }
  }

  /** `printFullResult` (L176-L192). */
  #printFullResult(test: Test, results: TestResult): void {
    const config = test.context.config as ProjectConfig
    const testDir = results.testFilePath.replace(config.rootDir, '').slice(1)
    const tree = getResultTree(results.testResults, testDir, results.perfStats)
    this.#printResultTree(tree, config, results.console)
  }

  /** `printResultTree` (L330-L371). */
  #printResultTree(
    tree: ResultTree,
    config: ProjectConfig,
    consoleLog: TestResult['console'],
  ): void {
    const perfMs = tree.performanceInfo.slow
      ? ` (${paint(['red', 'inverse'], `${tree.performanceInfo.runtime} ms`)})`
      : ` (${tree.performanceInfo.runtime} ms)`
    if (tree.passed) {
      this.#startGroup(`${paint(['bold', 'green', 'inverse'], 'PASS')} ${tree.name}${perfMs}`)
      if (consoleLog && !this.#silent && !(config.verbose ?? this.#globalConfig.verbose)) {
        log(consoleOutput(consoleLog, config, this.#globalConfig))
      }
      for (const child of tree.children) this.#printNode(child, true, 1)
      this.#endGroup()
    } else {
      log(`  ${paint(['bold', 'red', 'inverse'], 'FAIL')} ${tree.name}${perfMs}`)
      for (const child of tree.children) this.#printNode(child, false, 1)
    }
  }

  /** `recursivePrintResultTree` (L373-L433). */
  #printNode(node: ResultTreeNode | ResultTreeLeaf, alreadyGrouped: boolean, depth: number): void {
    if (node.children.length === 0) {
      if (!('duration' in node)) throw new Error('Expected a leaf. Got a node.')
      const spaces = '  '.repeat(alreadyGrouped ? depth : depth + 1)
      let symbol = ''
      switch (node.status) {
        case 'passed':
          symbol = paint('green', ICONS.success)
          break
        case 'failed':
          symbol = paint('red', ICONS.failed)
          break
        case 'todo':
          symbol = paint('magenta', ICONS.todo)
          break
        case 'pending':
        case 'skipped':
          symbol = paint('yellow', ICONS.pending)
          break
      }
      log(`${spaces + symbol} ${node.name} (${node.duration} ms)`)
      return
    }
    if (!('passed' in node)) throw new Error('Expected a node. Got a leaf')
    if (node.passed) {
      if (alreadyGrouped) {
        log('  '.repeat(depth) + node.name)
        for (const child of node.children) this.#printNode(child, true, depth + 1)
      } else {
        this.#startGroup('  '.repeat(depth) + node.name)
        for (const child of node.children) this.#printNode(child, true, depth + 1)
        this.#endGroup()
      }
    } else {
      log('  '.repeat(depth + 1) + node.name)
      for (const child of node.children) this.#printNode(child, false, depth + 1)
    }
  }

  #startGroup(title: string): void {
    log(`::group::${title}`)
  }

  #endGroup(): void {
    log('::endgroup::')
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

  /** `printFailedTestLogs` (L435-L476). */
  #printFailedTestLogs(
    context: Test,
    consoleLog: TestResult['console'],
    results: AggregatedResult,
  ): void {
    const config = context.context.config as ProjectConfig
    let written = false
    for (const result of results.testResults) {
      const testDir = result.testFilePath.replace(config.rootDir, '').slice(1)
      if (result.failureMessage) {
        if (!written) {
          log('')
          written = true
        }
        this.#startGroup(`Errors thrown in ${testDir}`)
        if (consoleLog && !this.#silent && !(config.verbose ?? this.#globalConfig.verbose)) {
          log(consoleOutput(consoleLog, config, this.#globalConfig))
        }
        log(result.failureMessage)
        this.#endGroup()
      }
    }
  }
}
