import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { stripVTControlCharacters } from 'node:util'
import { BenchError } from './errors.ts'
import { expectedTests, planRunner, type RunnerName, type SuiteSpec, suiteDir } from './suites.ts'

/**
 * The totals both Jest's `--json` and Vitest's JSON reporter put at the top of their output.
 * @public
 */
export interface TestSummary {
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly pending: number
  readonly todo: number
  readonly success: boolean
}

function field(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Reads the totals out of a parsed Jest or Vitest JSON report, or `undefined` if the shape is
 * not one.
 * @public
 */
export function parseTestSummary(report: unknown): TestSummary | undefined {
  const object = asRecord(report)
  if (object === undefined) return undefined
  const total = field(object, 'numTotalTests')
  const passed = field(object, 'numPassedTests')
  const failed = field(object, 'numFailedTests')
  const pending = field(object, 'numPendingTests')
  const todo = field(object, 'numTodoTests')
  if (
    total === undefined ||
    passed === undefined ||
    failed === undefined ||
    pending === undefined ||
    todo === undefined ||
    typeof object.success !== 'boolean'
  ) {
    return undefined
  }
  return { total, passed, failed, pending, todo, success: object.success }
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

/**
 * Up to `limit` failed tests from a Jest or Vitest JSON report, each as `file > test: first line
 * of the message`.
 * @public
 */
export function failureMessages(report: unknown, limit = 3): readonly string[] {
  const out: string[] = []
  const files = asRecord(report)?.testResults
  if (!Array.isArray(files)) return out
  for (const file of files) {
    const fileRecord = asRecord(file)
    if (fileRecord === undefined || fileRecord.status !== 'failed') continue
    const name = String(fileRecord.name ?? 'unknown file')
    const assertions = Array.isArray(fileRecord.assertionResults) ? fileRecord.assertionResults : []
    const failed = assertions.map(asRecord).filter((a) => a?.status === 'failed')
    if (failed.length === 0) {
      out.push(`${name}: ${firstLine(fileRecord.message)}`)
    }
    for (const assertion of failed) {
      const messages = Array.isArray(assertion?.failureMessages) ? assertion.failureMessages : []
      out.push(
        `${name} > ${String(assertion?.fullName ?? assertion?.title)}: ${firstLine(messages[0])}`,
      )
    }
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

function firstLine(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return (
    stripVTControlCharacters(text)
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? '(no message)'
  )
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

const TAIL_BYTES = 6000

function runCaptured(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<{ exitCode: number; wallMs: number; tail: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv
    if (command === undefined) {
      reject(new BenchError('BENCH_EXEC_FAILED', 'empty command'))
      return
    }
    const startedAt = performance.now()
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-TAIL_BYTES)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.once('error', (cause) =>
      reject(new BenchError('BENCH_EXEC_FAILED', `could not run ${command}`, { cause })),
    )
    child.once('close', (code, signal) =>
      resolve({
        exitCode: code ?? (signal === null ? 1 : 128),
        wallMs: performance.now() - startedAt,
        tail,
      }),
    )
  })
}

/**
 * Runs a suite once under a runner with JSON output, and judges it. The report goes to
 * `<suite>/check/<runner>.json`.
 * @public
 */
export async function checkRunner(
  spec: SuiteSpec,
  runner: RunnerName,
  options?: { readonly root?: string },
): Promise<CheckResult> {
  const reportPath = join(suiteDir(spec, options?.root), 'check', `${runner}.json`)
  const flags =
    runner === 'jest'
      ? ['--json', `--outputFile=${reportPath}`]
      : ['--reporter=json', `--outputFile=${reportPath}`]
  const plan = planRunner(spec, runner, { ...options, extraArgs: flags })
  await mkdir(dirname(reportPath), { recursive: true })
  await rm(reportPath, { force: true })

  const run = await runCaptured(plan.argv, plan.cwd, plan.env)

  let report: unknown
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch {
    report = undefined
  }
  const summary = parseTestSummary(report)
  const problems = checkProblems(run.exitCode, summary, expectedTests(spec))
  const failures = failureMessages(report)
  const details =
    problems.length === 0 ? [] : failures.length > 0 ? failures : [`output tail:\n${run.tail}`]
  return {
    runner,
    version: plan.version,
    ok: problems.length === 0,
    exitCode: run.exitCode,
    wallMs: run.wallMs,
    summary,
    problems,
    details,
  }
}
