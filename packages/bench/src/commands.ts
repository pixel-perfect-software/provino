import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { checkRunner } from './check.ts'
import { parseCli, USAGE } from './cli-args.ts'
import { readEnvironment, readRunRef } from './environment.ts'
import { BenchError } from './errors.ts'
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

const processIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}

async function generated(suite: SuiteSpec, io: CliIo): Promise<void> {
  const summary = await writeSuite(suite)
  io.err(
    `${suite.name}: ${summary.written} files written, ${summary.unchanged} unchanged, ${summary.removed} removed in ${summary.dir}`,
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

/**
 * Runs the command line and returns the exit code: 0 on success, 1 when a check or run failed, 2
 * for a usage error.
 * @public
 */
export async function runCli(argv: readonly string[], io: CliIo = processIo): Promise<number> {
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
      case 'run': {
        await generated(command.suite, io)
        const plans = command.runners.map((runner) => planRunner(command.suite, runner))
        const warnings = new Set<string>()
        const results = await runBench({
          benchId: command.suite.name,
          subjects: plans.map(toSubjectSpec),
          warmRuns: command.warm,
          coldRuns: command.cold,
          onRun: ({ subject, phase, round, rounds, outcome }) => {
            for (const warning of outcome.warnings ?? []) warnings.add(warning)
            io.err(
              `[${command.label}] ${command.suite.name} ${subject.runner} ${phase} ${round}/${rounds}: ${outcome.wallMs.toFixed(0)} ms, exit ${outcome.exitCode}`,
            )
          },
        })
        for (const warning of warnings) io.err(`[${command.label}] note: ${warning}`)

        const ref = readRunRef({ cwd: REPO_ROOT })
        const record = buildRecord({
          label: command.label,
          ref,
          environment: readEnvironment(
            Object.fromEntries(plans.map((plan) => [plan.runner, plan.version])),
          ),
          machineId: command.machineId ?? defaultMachineId(command.label),
          results,
        })
        const out =
          command.out === undefined ? defaultOutPath(ref, command.suite.name) : resolve(command.out)
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, `${JSON.stringify(record, null, 2)}\n`)
        io.out(formatSummary(record))
        io.out(`[${command.label}] wrote ${out}`)
        return results.every((result) => result.ok) ? 0 : 1
      }
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
