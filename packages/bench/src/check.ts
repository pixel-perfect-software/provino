import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { type ProcessResult, parseJestJson, parseVitestJson, runProcess } from '@provino/harness'
import { BenchError } from './errors.ts'
import {
  checkMs,
  DEFAULT_RUN_TIMEOUT_MS,
  describeDuration,
  exitCodeOf,
  TIMEOUT_EXIT_CODE,
} from './exec.ts'
import { hasCode } from './internal/guards.ts'
import {
  type BenchPaths,
  DEFAULT_PATHS,
  expectedTests,
  planRunner,
  type RunnerName,
  type SuiteSpec,
  suiteDir,
} from './suites.ts'

/**
 * The totals both Jest's `--json` and Vitest's JSON reporter put at the top of their output.
 * @public
 */
export interface TestSummary {
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly success: boolean
}

/**
 * What the check reads of a parsed report, which both runners write in this shape.
 * @public
 */
export interface Report {
  readonly numTotalTests: number
  readonly numPassedTests: number
  readonly numFailedTests: number
  readonly success: boolean
  readonly testResults: readonly {
    readonly name: string
    readonly status: string
    readonly message: string
    readonly assertionResults: readonly {
      readonly title: string
      readonly fullName?: string
      readonly status: string
      readonly failureMessages?: readonly (string | null)[] | null
    }[]
  }[]
}

// How each runner is asked for a JSON report, and how the report is parsed.
const REPORTERS: Readonly<
  Record<
    RunnerName,
    { readonly flag: string; readonly parse: (text: string, source: string) => Report }
  >
> = {
  jest: { flag: '--json', parse: parseJestJson },
  vitest: { flag: '--reporter=json', parse: parseVitestJson },
}

/**
 * Reads the report a runner wrote at `path`. A report that was never written, or that is not this
 * runner's report, is `undefined`; any other failure to read it is thrown.
 * @public
 */
export async function readReport(runner: RunnerName, path: string): Promise<Report | undefined> {
  try {
    return REPORTERS[runner].parse(await readFile(path, 'utf8'), path)
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'HARNESS_RESULT_INVALID')) return undefined
    throw error
  }
}

/**
 * The totals of a report.
 * @public
 */
export function summarize(report: Report): TestSummary {
  return {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    success: report.success,
  }
}

/**
 * What is wrong with a runner's run of a suite, as sentences; empty if it passed. A suite passes
 * when the runner exited 0 and reported success, with exactly the expected number of tests, all
 * passed.
 * @public
 */
export function checkProblems(
  exitCode: number,
  summary: TestSummary | undefined,
  expected: number,
): readonly string[] {
  const problems: string[] = []
  if (exitCode !== 0) problems.push(`exited ${exitCode}`)
  if (summary === undefined) {
    problems.push('wrote no readable JSON report')
    return problems
  }
  if (!summary.success) problems.push('reported failure')
  if (summary.total !== expected) {
    problems.push(`ran ${summary.total} tests, expected ${expected}`)
  }
  if (summary.passed !== expected) {
    problems.push(`${summary.passed} tests passed, expected ${expected}`)
  }
  if (summary.failed > 0) problems.push(`${summary.failed} tests failed`)
  return problems
}

function firstLine(message: string | null | undefined): string {
  return (
    stripVTControlCharacters(message ?? '')
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? '(no message)'
  )
}

/**
 * Up to `limit` failures from a report, each as `file > test: first line of the message`, or
 * `file: first line` for a file that failed without a failed test.
 * @public
 */
export function failureDetails(report: Report, limit = 3): readonly string[] {
  const out: string[] = []
  for (const file of report.testResults) {
    if (file.status !== 'failed') continue
    const failed = file.assertionResults.filter((assertion) => assertion.status === 'failed')
    if (failed.length === 0) out.push(`${file.name}: ${firstLine(file.message)}`)
    for (const assertion of failed) {
      const name = assertion.fullName ?? assertion.title
      out.push(`${file.name} > ${name}: ${firstLine(assertion.failureMessages?.[0])}`)
    }
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

/**
 * The outcome of checking one runner on a suite.
 * @public
 */
export interface CheckResult {
  readonly runner: RunnerName
  readonly version: string
  readonly ok: boolean
  readonly exitCode: number
  readonly wallMs: number
  readonly summary: TestSummary | undefined
  readonly problems: readonly string[]
  /** The first failures from the report, and for a run that wrote no report, the output's tail. */
  readonly details: readonly string[]
}

const TAIL_CHARS = 6000

/**
 * Runs a suite once under a runner with JSON output, and judges it. The report goes to
 * `<suite>/check/<runner>.json`. A run that takes longer than `timeoutMs` (default
 * `DEFAULT_RUN_TIMEOUT_MS`) has its whole process group killed and fails the check with exit
 * `TIMEOUT_EXIT_CODE`.
 * @public
 */
export async function checkRunner(
  spec: SuiteSpec,
  runner: RunnerName,
  options?: { readonly paths?: BenchPaths; readonly timeoutMs?: number },
): Promise<CheckResult> {
  const paths = options?.paths ?? DEFAULT_PATHS
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  checkMs(timeoutMs, 'timeoutMs', 1)
  const reportPath = join(suiteDir(spec, paths.suitesRoot), 'check', `${runner}.json`)
  const flags = [REPORTERS[runner].flag, `--outputFile=${reportPath}`]
  const plan = planRunner(spec, runner, { paths, extraArgs: flags })
  await mkdir(dirname(reportPath), { recursive: true })
  await rm(reportPath, { force: true })

  const [command, ...args] = plan.argv
  if (command === undefined) throw new BenchError('BENCH_EXEC_FAILED', 'empty command')
  let run: ProcessResult
  try {
    run = await runProcess(command, args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      timeoutMs,
      tailChars: TAIL_CHARS,
    })
  } catch (cause) {
    throw new BenchError('BENCH_EXEC_FAILED', `could not run ${command}`, { cause })
  }

  const exitCode = run.timedOut ? TIMEOUT_EXIT_CODE : exitCodeOf(run.exitCode, run.signal)
  const report = await readReport(runner, reportPath)
  const summary = report === undefined ? undefined : summarize(report)
  const problems = [...checkProblems(exitCode, summary, expectedTests(spec))]
  if (run.timedOut) problems.push(`timed out after ${describeDuration(timeoutMs)} and was killed`)
  for (const problem of run.problems) problems.push(`could not stop the process group: ${problem}`)
  const failures = report === undefined ? [] : failureDetails(report)
  const details =
    problems.length === 0 ? [] : failures.length > 0 ? failures : [`output tail:\n${run.output}`]
  return {
    runner,
    version: plan.version,
    ok: problems.length === 0,
    exitCode,
    wallMs: run.wallMs,
    summary,
    problems,
    details,
  }
}
