import { resolve } from 'node:path'
import { checkRunner } from './check.ts'
import { type CliCommand, parseCli, USAGE } from './cli-args.ts'
import { readEnvironment, readRunRef, requireCleanTree } from './environment.ts'
import { BenchError } from './errors.ts'
import type { ExecProcess } from './exec.ts'
import { prepareOutput, writeRecordFile } from './output.ts'
import { buildRecord, defaultMachineId, defaultOutPath, formatSummary } from './report.ts'
import { runBench } from './run-bench.ts'
import { planRunner, REPO_ROOT, type SuiteSpec, toSubjectSpec, writeSuite } from './suites.ts'

/**
 * Where the CLI writes. Tests pass their own.
 * @public
 */
export interface CliIo {
  out(text: string): void
  err(text: string): void
}

/**
 * Test seams for the `run` command: the process runner, where the repository, the generated suites
 * and the records live, and the clock. Each defaults to the real thing.
 * @public
 */
export interface CliDeps {
  readonly exec?: ExecProcess
  readonly repoRoot?: string
  readonly suitesRoot?: string
  readonly resultsDir?: string
  readonly now?: () => Date
}

const processIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}

async function generated(suite: SuiteSpec, io: CliIo, root?: string): Promise<void> {
  const summary = await writeSuite(suite, root === undefined ? undefined : { root })
  io.err(
    `${suite.name}: ${summary.written} files written, ${summary.unchanged} unchanged, ${summary.removed} removed in ${summary.dir}`,
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

// The `run` command. Everything that can fail without running a benchmark is done first: reading
// the commit, refusing a dirty tree for a quotable label, planning the runners, and checking that
// the record can be written. A failure after the runs would throw away up to 16 of them per
// subject, so none is left for then; the one write that remains is atomic and keeps what it can't
// place.
async function runCommand(
  command: Extract<CliCommand, { readonly command: 'run' }>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const { suite, label } = command
  const now = deps.now?.()
  const ref = readRunRef({
    cwd: deps.repoRoot ?? REPO_ROOT,
    ...(now === undefined ? {} : { now }),
  })
  requireCleanTree(label, ref)
  const out =
    command.out === undefined
      ? defaultOutPath(ref, suite.name, deps.resultsDir)
      : resolve(command.out)
  await prepareOutput(out)
  const rootOption = deps.suitesRoot === undefined ? undefined : { root: deps.suitesRoot }
  const plans = command.runners.map((runner) => planRunner(suite, runner, rootOption))
  const environment = readEnvironment(
    Object.fromEntries(plans.map((plan) => [plan.runner, plan.version])),
  )
  await generated(suite, io, deps.suitesRoot)

  const warnings = new Set<string>()
  const results = await runBench({
    benchId: suite.name,
    subjects: plans.map(toSubjectSpec),
    warmRuns: command.warm,
    coldRuns: command.cold,
    timeoutMs: command.timeoutMs,
    ...(deps.exec === undefined ? {} : { exec: deps.exec }),
    onRun: ({ subject, phase, round, rounds, outcome }) => {
      for (const warning of outcome.warnings ?? []) warnings.add(warning)
      io.err(
        `[${label}] ${suite.name} ${subject.runner} ${phase} ${round}/${rounds}: ${outcome.wallMs.toFixed(0)} ms, exit ${outcome.exitCode}`,
      )
    },
  })
  for (const warning of warnings) io.err(`[${label}] note: ${warning}`)

  const record = buildRecord({
    label,
    ref,
    environment,
    machineId: command.machineId ?? defaultMachineId(label),
    results,
  })
  io.out(formatSummary(record))
  const text = `${JSON.stringify(record, null, 2)}\n`
  try {
    await writeRecordFile(out, text)
  } catch (error) {
    // Last resort: the runs are in the summary above; put the whole record where it can be saved.
    io.err(text.trimEnd())
    throw error
  }
  io.out(`[${label}] wrote ${out}`)
  return results.every((result) => result.ok) ? 0 : 1
}

/**
 * Runs the command line and returns the exit code: 0 on success, 1 when a check or run failed, 2
 * for a usage error.
 * @public
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo,
  deps: CliDeps = {},
): Promise<number> {
  try {
    const command = parseCli(argv)
    switch (command.command) {
      case 'help':
        io.out(USAGE)
        return 0
      case 'generate':
        await generated(command.suite, io)
        return 0
      case 'check': {
        await generated(command.suite, io)
        let failed = false
        for (const runner of command.runners) {
          const result = await checkRunner(command.suite, runner)
          const { summary } = result
          const counts =
            summary === undefined ? 'no report' : `${summary.passed}/${summary.total} tests passed`
          io.out(
            `${result.ok ? 'PASS' : 'FAIL'} ${runner} ${result.version} ${command.suite.name}: ${counts} in ${seconds(result.wallMs)}`,
          )
          if (!result.ok) {
            failed = true
            for (const problem of result.problems) io.out(`  ${problem}`)
            for (const detail of result.details) io.out(`  ${detail}`)
          }
        }
        return failed ? 1 : 0
      }
      case 'run':
        return await runCommand(command, io, deps)
    }
  } catch (error) {
    if (!(error instanceof BenchError)) throw error
    io.err(`provino-bench: ${error.code}: ${error.message}`)
    if (error.code === 'BENCH_USAGE') {
      io.err('run provino-bench --help for usage')
      return 2
    }
    return 1
  }
}
