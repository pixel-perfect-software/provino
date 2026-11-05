import { mkdir, readFile, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import {
  type ProcessResult,
  parseJestJson,
  parseNormalizedRun,
  parseVitestJson,
  runProcess,
} from '@provino/harness'
import { defaultMaxWorkers } from '@provino/orchestrator'
import type { NormalizedRun } from '@provino/types'
import { BenchError } from './errors.ts'
import {
  checkMs,
  DEFAULT_RUN_TIMEOUT_MS,
  describeDuration,
  exitCodeOf,
  TIMEOUT_EXIT_CODE,
} from './exec.ts'
import { errorMessage, hasCode } from './internal/guards.ts'
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

/**
 * A Provino run as a report: Provino writes its own model (`normalized-json`), so the check reads
 * it the way it reads the others. A crashed file is a failed file, with its error as the message.
 */
function reportOfRun(run: NormalizedRun): Report {
  const tests = run.files.flatMap((file) => file.tests)
  const count = (status: string): number => tests.filter((test) => test.status === status).length
  return {
    numTotalTests: tests.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    success: run.success,
    testResults: run.files.map((file) => ({
      name: file.file,
      status: file.status === 'crashed' ? 'failed' : file.status,
      message: file.fileError?.message ?? '',
      assertionResults: file.tests.map((test) => ({
        title: test.id.path.at(-1) ?? '',
        fullName: test.id.path.join(' '),
        status: test.status,
        failureMessages: test.errors.map((error) => error.message),
      })),
    })),
  }
}

// How each runner is asked for a report and how the report is parsed. Provino is asked for both
// reporters (the console one is what a person reads, the JSON one is what the check judges) and
// for no results cache, so a check always runs every file, in the order it computes, from scratch.
const REPORTERS: Readonly<
  Record<
    RunnerName,
    {
      readonly args: (outputFile: string) => readonly string[]
      readonly parse: (text: string, source: string) => Parsed
    }
  >
> = {
  jest: {
    args: (outputFile) => ['--json', `--outputFile=${outputFile}`],
    parse: (text, source) => {
      const jest = parseJestJson(text, source)
      return { report: jest, parsed: { jest } }
    },
  },
  vitest: {
    args: (outputFile) => ['--reporter=json', `--outputFile=${outputFile}`],
    parse: (text, source) => ({ report: parseVitestJson(text, source), parsed: {} }),
  },
  provino: {
    args: (outputFile) => [
      '--reporter',
      'default',
      '--reporter',
      'normalized-json',
      '--outputFile',
      outputFile,
      '--no-cache',
    ],
    parse: (text, source) => {
      const provino = parseNormalizedRun(text, source)
      return { report: reportOfRun(provino), parsed: { provino } }
    },
  },
}

/**
 * What a parsed report came from, for a caller that needs the original (the parity check compares
 * Jest's JSON and Provino's `NormalizedRun`, not the `Report` view of them).
 * @public
 */
export interface ParsedReport {
  readonly jest?: ReturnType<typeof parseJestJson>
  readonly provino?: NormalizedRun
}

/** A parsed report: the `Report` view the check judges, and the original where one is kept. */
interface Parsed {
  readonly report: Report
  readonly parsed: ParsedReport
}

/** What reading a report found: the report, or why there is none (`invalid` is set for a file that exists but isn't this runner's report). */
interface ReportRead {
  readonly report?: Report
  readonly parsed?: ParsedReport
  readonly invalid?: string
}

async function loadReport(runner: RunnerName, path: string): Promise<ReportRead> {
  try {
    return REPORTERS[runner].parse(await readFile(path, 'utf8'), path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return {}
    if (hasCode(error, 'HARNESS_RESULT_INVALID')) return { invalid: errorMessage(error) }
    throw error
  }
}

/**
 * Reads the report a runner wrote at `path`. A report that was never written, or that is not this
 * runner's report, is `undefined`; any other failure to read it is thrown.
 * @public
 */
export async function readReport(runner: RunnerName, path: string): Promise<Report | undefined> {
  return (await loadReport(runner, path)).report
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
  /** Facts about the run worth printing next to the verdict, e.g. Provino's worker count. */
  readonly notes: readonly string[]
  /** The report as parsed, where the run wrote a valid one (for `checkStatusParity`). */
  readonly parsed?: ParsedReport
}

const TAIL_CHARS = 6000

/**
 * What the check says of a Provino run besides the verdict: how many workers it ran with (it is
 * never passed `--maxWorkers`, so the default is part of what is checked; the bench computes it
 * the way the pool does, on the same machine), and, once its JSON was read, that the JSON passed
 * `parseNormalizedRun`.
 */
function provinoNotes(parsed: boolean): readonly string[] {
  const notes = [
    `maxWorkers ${defaultMaxWorkers()}: the default, ${availableParallelism()} cores - 1 and at least 1 (no --maxWorkers passed)`,
  ]
  if (parsed) notes.push('normalized-json: schema valid (parseNormalizedRun accepted it)')
  return notes
}

/**
 * Runs a suite once under a runner with a report, and judges it. The report goes to
 * `<suite>/check/<runner>.json`. A run that takes longer than `timeoutMs` (default
 * `DEFAULT_RUN_TIMEOUT_MS`) has its whole process group killed and fails the check with exit
 * `TIMEOUT_EXIT_CODE`. A Provino run is judged on the same terms as the others, after its
 * `normalized-json` passes `parseNormalizedRun`; a file that doesn't is named in `details`.
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
  const plan = planRunner(spec, runner, { paths, extraArgs: REPORTERS[runner].args(reportPath) })
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
  const { report, parsed, invalid } = await loadReport(runner, reportPath)
  const summary = report === undefined ? undefined : summarize(report)
  const problems = [...checkProblems(exitCode, summary, expectedTests(spec))]
  if (run.timedOut) problems.push(`timed out after ${describeDuration(timeoutMs)} and was killed`)
  for (const problem of run.problems) problems.push(`could not stop the process group: ${problem}`)
  const failures = report === undefined ? [] : failureDetails(report)
  const details =
    problems.length === 0
      ? []
      : [
          ...(invalid === undefined ? [] : [`${runner}'s report is not valid: ${invalid}`]),
          ...(failures.length > 0 ? failures : [`output tail:\n${run.output}`]),
        ]
  return {
    runner,
    version: plan.version,
    ok: problems.length === 0,
    exitCode,
    wallMs: run.wallMs,
    summary,
    problems,
    details,
    notes: runner === 'provino' ? provinoNotes(report !== undefined) : [],
    ...(parsed === undefined ? {} : { parsed }),
  }
}
