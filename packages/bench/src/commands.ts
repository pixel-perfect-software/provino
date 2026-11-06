import { resolve } from 'node:path'
import { readRunEnvironment } from '@provino/harness'
import type { BenchLabel, BenchRecord, BenchResult, RunRef } from '@provino/types'
import { type CheckResult, checkRunner } from './check.ts'
import { type CliCommand, parseCli, USAGE } from './cli-args.ts'
import { readRunRef } from './environment.ts'
import { BenchError } from './errors.ts'
import type { ExecProcess } from './exec.ts'
import { errorMessage } from './internal/guards.ts'
import {
  DRY_RUN_RUNNER,
  evaluateKillCheck,
  formatKillCheck,
  ISOLATION_SUITE,
  type KillCheckSuite,
  R6_SUITES,
} from './kill-check.ts'
import { prepareOutput, writeRecordFile } from './output.ts'
import { checkStatusParity, parityLines, type StatusParity, unavailableParity } from './parity.ts'
import {
  buildRecord,
  defaultMachineId,
  defaultOutPath,
  formatSummary,
  requireCleanTree,
  subjectName,
} from './report.ts'
import { type BenchSubjectSpec, type RunEvent, runBench } from './run-bench.ts'
import {
  type BenchPaths,
  DEFAULT_PATHS,
  parseSuiteName,
  planRunner,
  type RunnerName,
  type RunnerPlan,
  type SuiteSpec,
  toSubjectSpec,
  writeSuite,
} from './suites.ts'

/**
 * Where the CLI writes. Tests pass their own.
 * @public
 */
export interface CliIo {
  out(text: string): void
  err(text: string): void
}

/**
 * Test seams: the process runner (`run` and `kill-check`), the kill-check's parity read, where the
 * repository, the generated suites and the records live, and the clock. Each defaults to the real
 * thing. `readParity` runs Jest and Provino once each, outside the timed runs, and compares their
 * reports; a test with a fake `exec` replaces it so no real runner starts.
 * @public
 */
export interface CliDeps {
  readonly exec?: ExecProcess
  readonly readParity?: (suite: SuiteSpec) => Promise<StatusParity>
  readonly paths?: BenchPaths
  readonly now?: () => Date
}

const processIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}

async function generated(suite: SuiteSpec, io: CliIo, suitesRoot: string): Promise<void> {
  const summary = await writeSuite(suite, suitesRoot)
  io.err(
    `${suite.name}: ${summary.written} files written, ${summary.unchanged} unchanged, ${summary.removed} removed in ${summary.dir}`,
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

// The progress line for each timed run, and the notes the runs raised (printed once, after).
function progressReporter(
  io: CliIo,
  label: BenchLabel,
): { readonly onRun: (event: RunEvent) => void; flush(): void } {
  const warnings = new Set<string>()
  return {
    onRun: ({ benchId, subject, phase, round, rounds, outcome }) => {
      for (const warning of outcome.warnings ?? []) warnings.add(warning)
      io.err(
        `[${label}] ${benchId} ${subjectName(subject)} ${phase} ${round}/${rounds}: ${outcome.wallMs.toFixed(0)} ms, exit ${outcome.exitCode}`,
      )
    },
    flush: () => {
      for (const warning of warnings) io.err(`[${label}] note: ${warning}`)
      warnings.clear()
    },
  }
}

// Saves the record first and only then prints, so a throw while formatting or judging can never
// lose runs that are already measured. The order: write the record; run `report` (it prints the
// summary and the verdict, and returns what the caller needs); print `wrote <path>` last. If the
// write fails, the whole record goes to stderr at once, `report` still runs, and the write error is
// rethrown. If `report` fails after a good write, the wrote line still prints and its error is
// rethrown.
async function persistRecord<T>(
  record: BenchRecord,
  out: string,
  io: CliIo,
  report: () => T,
): Promise<Awaited<T>> {
  const text = `${JSON.stringify(record, null, 2)}\n`
  const written = await settle(() => writeRecordFile(out, text))
  if (!written.ok) io.err(text.trimEnd())
  const reported = await settle(report)
  if (!written.ok) throw written.error
  io.out(`[${record.label}] wrote ${out}`)
  if (!reported.ok) throw reported.error
  return reported.value
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

// Runs `fn` and holds its outcome, so a caller can finish what must happen before it rethrows.
async function settle<T>(fn: () => T): Promise<Settled<Awaited<T>>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

// What `run` and `kill-check` settle before they run anything: the commit, the clean-tree rule and
// the record's path (`defaultName` names the file when `--out` isn't given), which must be writable.
async function prepareRun(
  command: { readonly label: BenchLabel; readonly out: string | undefined },
  defaultName: string,
  deps: CliDeps,
  paths: BenchPaths,
): Promise<{ readonly ref: RunRef; readonly out: string }> {
  const now = deps.now?.()
  const ref = readRunRef({ cwd: paths.repoRoot, ...(now === undefined ? {} : { now }) })
  requireCleanTree(command.label, ref)
  const out =
    command.out === undefined
      ? defaultOutPath(ref, defaultName, paths.resultsDir)
      : resolve(command.out)
  await prepareOutput(out)
  return { ref, out }
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
  paths: BenchPaths,
): Promise<number> {
  const { suite, label } = command
  const { ref, out } = await prepareRun(command, suite.name, deps, paths)
  const plans = command.runners.map((runner) => planRunner(suite, runner, { paths }))
  const environment = readRunEnvironment(
    Object.fromEntries(plans.map((plan) => [plan.runner, plan.version])),
  )
  await generated(suite, io, paths.suitesRoot)

  const progress = progressReporter(io, label)
  const results = await runBench({
    benchId: suite.name,
    subjects: plans.map(toSubjectSpec),
    warmRuns: command.warm,
    coldRuns: command.cold,
    timeoutMs: command.timeoutMs,
    ...(deps.exec === undefined ? {} : { exec: deps.exec }),
    onRun: progress.onRun,
  })
  progress.flush()

  const record = buildRecord({
    label,
    ref,
    environment,
    machineId: command.machineId ?? defaultMachineId(label),
    results,
  })
  await persistRecord(record, out, io, () => io.out(formatSummary(record)))
  return results.every((result) => result.ok) ? 0 : 1
}

// Jest and Provino each once, with reports, outside the timed runs (the report flags cost time),
// then their per-test statuses compared. `checkStatusParity` reads a report from disk when it isn't
// handed one, and a missing file would be a raw ENOENT, so it is called only when both runs wrote
// a valid report. Parity is a fraction, so it is compared even when a run failed.
async function readRealParity(
  suite: SuiteSpec,
  io: CliIo,
  paths: BenchPaths,
  timeoutMs: number,
): Promise<StatusParity> {
  const jest = await checkRunner(suite, 'jest', { paths, timeoutMs })
  const provino = await checkRunner(suite, 'provino', { paths, timeoutMs })
  for (const result of [jest, provino]) {
    const { summary } = result
    const counts =
      summary === undefined ? 'no report' : `${summary.passed}/${summary.total} tests passed`
    io.err(
      `${suite.name} parity read: ${result.runner} ${result.version} ${result.ok ? 'passed' : 'FAILED'}: ${counts} in ${seconds(result.wallMs)} (not timed, not a result)`,
    )
    if (!result.ok) {
      for (const problem of result.problems) io.err(`  ${problem}`)
      for (const detail of result.details) io.err(`  ${detail}`)
    }
  }
  const jestReport = jest.parsed?.jest
  const provinoReport = provino.parsed?.provino
  if (jestReport === undefined) return unavailableParity('jest wrote no valid report')
  if (provinoReport === undefined) return unavailableParity('provino wrote no valid report')
  return await checkStatusParity(
    suite,
    { jest: jest.version, provino: provino.version },
    { paths, reports: { jest: jestReport, provino: provinoReport } },
  )
}

// One measured suite of the gate: Jest as the baseline, then Provino at `registry` (and at `none` on
// `ISOLATION_SUITE`), or on a dry run Jest in Provino's place.
function planKillCheckSuite(
  entry: KillCheckSuite,
  dryRun: boolean,
  paths: BenchPaths,
): {
  readonly suite: SuiteSpec
  readonly plans: readonly RunnerPlan[]
  readonly subjects: readonly BenchSubjectSpec[]
} {
  const suite = parseSuiteName(entry.name)
  const jest = planRunner(suite, 'jest', { paths })
  const baseline = toSubjectSpec(jest)
  const tiers =
    suite.name === ISOLATION_SUITE ? (['registry', 'none'] as const) : (['registry'] as const)
  if (dryRun) {
    // Jest in Provino's place: the same argv, cwd, env, caches and command, with a runner id that
    // can never be taken for Provino's record.
    const standIns: BenchSubjectSpec[] = tiers.map((isolation) => ({
      ...baseline,
      subject: { ...baseline.subject, runner: DRY_RUN_RUNNER, isolation },
    }))
    return { suite, plans: [jest], subjects: [baseline, ...standIns] }
  }
  const provino = tiers.map((isolation) => planRunner(suite, 'provino', { paths, isolation }))
  return { suite, plans: [jest, ...provino], subjects: [baseline, ...provino.map(toSubjectSpec)] }
}

// A parity read that throws fails the gate closed rather than ending the run: the timed runs still
// happen and the record is still saved.
async function readParityOrFail(
  readParity: (suite: SuiteSpec) => Promise<StatusParity>,
  suite: SuiteSpec,
): Promise<StatusParity> {
  try {
    return await readParity(suite)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return unavailableParity(
      error instanceof BenchError ? `${error.code}: ${error.message}` : errorMessage(error),
    )
  }
}

// The `kill-check` command (Track 12 R6, T12.15, provisional). Like `run`, everything that can fail
// without running a benchmark happens first: the commit, the clean-tree rule, the record's path and
// every subject's plan. Then, per measured suite: generate it, read parity (not on a dry run), and
// run the subjects interleaved. Provino's timed runs are never passed `--no-cache`: its results
// cache only orders the next run's files (D19's scheduling data), it never skips one, and every run
// is a fresh process, so no pool or daemon carries over. All numbers are measured even when parity
// failed: no run is skipped or dropped.
async function killCheckCommand(
  command: Extract<CliCommand, { readonly command: 'kill-check' }>,
  io: CliIo,
  deps: CliDeps,
  paths: BenchPaths,
): Promise<number> {
  const { label, dryRun } = command
  const { ref, out } = await prepareRun(
    command,
    dryRun ? 'kill-check-dry-run' : 'kill-check',
    deps,
    paths,
  )

  const planned = R6_SUITES.filter((entry) => entry.pending === undefined).map((entry) =>
    planKillCheckSuite(entry, dryRun, paths),
  )
  // Only what actually runs is named: a dry run's record claims no Provino version.
  const environment = readRunEnvironment(
    Object.fromEntries(
      planned.flatMap(({ plans }) => plans.map((plan) => [plan.runner, plan.version])),
    ),
  )

  const readParity =
    deps.readParity ?? ((suite: SuiteSpec) => readRealParity(suite, io, paths, command.timeoutMs))
  const parity = new Map<string, StatusParity>()
  const results: BenchResult[] = []
  const progress = progressReporter(io, label)
  for (const { suite, subjects } of planned) {
    await generated(suite, io, paths.suitesRoot)
    if (!dryRun) {
      const read = await readParityOrFail(readParity, suite)
      parity.set(suite.name, read)
      for (const line of parityLines(read)) io.err(`[${label}] ${suite.name} ${line}`)
    }
    // R6 fixes 10 warm and 5 cold runs, so the defaults are used and no count is passed.
    results.push(
      ...(await runBench({
        benchId: suite.name,
        subjects,
        timeoutMs: command.timeoutMs,
        ...(deps.exec === undefined ? {} : { exec: deps.exec }),
        onRun: progress.onRun,
      })),
    )
    progress.flush()
  }

  const record = buildRecord({
    label,
    ref,
    environment,
    machineId: command.machineId ?? defaultMachineId(label),
    results,
  })
  const outcome = await persistRecord(record, out, io, () => {
    io.out(formatSummary(record))
    const verdict = evaluateKillCheck({ record, suites: R6_SUITES, parity, dryRun })
    for (const line of formatKillCheck(verdict)) io.out(line)
    return verdict.outcome
  })
  return outcome === 'GO' ? 0 : 1
}

// The `check` command: each runner once, then Provino against Jest when both ran and passed.
async function checkCommand(
  command: Extract<CliCommand, { readonly command: 'check' }>,
  io: CliIo,
  paths: BenchPaths,
): Promise<number> {
  await generated(command.suite, io, paths.suitesRoot)
  let failed = false
  const results = new Map<RunnerName, CheckResult>()
  for (const runner of command.runners) {
    const result = await checkRunner(command.suite, runner, {
      paths,
      timeoutMs: command.timeoutMs,
    })
    results.set(runner, result)
    const { summary } = result
    const counts =
      summary === undefined ? 'no report' : `${summary.passed}/${summary.total} tests passed`
    io.out(
      `${result.ok ? 'PASS' : 'FAIL'} ${runner} ${result.version} ${command.suite.name}: ${counts} in ${seconds(result.wallMs)} (local, one run: not a result)`,
    )
    for (const note of result.notes) io.out(`  ${note}`)
    if (!result.ok) {
      failed = true
      for (const problem of result.problems) io.out(`  ${problem}`)
      for (const detail of result.details) io.out(`  ${detail}`)
    }
  }
  // Provino against Jest, once both have passed: every test the same status.
  const jest = results.get('jest')
  const provino = results.get('provino')
  if (jest !== undefined && provino !== undefined) {
    if (jest.ok && provino.ok) {
      // The reports the runs were judged on are compared, not read and validated again.
      const reports = {
        ...(jest.parsed?.jest === undefined ? {} : { jest: jest.parsed.jest }),
        ...(provino.parsed?.provino === undefined ? {} : { provino: provino.parsed.provino }),
      }
      const parity = await checkStatusParity(
        command.suite,
        { jest: jest.version, provino: provino.version },
        { paths, reports },
      )
      for (const line of parityLines(parity)) io.out(line)
      if (!parity.ok) failed = true
    } else {
      io.out('status parity: not compared, because a run above failed')
    }
  }
  return failed ? 1 : 0
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
    const paths = deps.paths ?? DEFAULT_PATHS
    switch (command.command) {
      case 'help':
        io.out(USAGE)
        return 0
      case 'generate':
        await generated(command.suite, io, paths.suitesRoot)
        return 0
      case 'check':
        return await checkCommand(command, io, paths)
      case 'run':
        return await runCommand(command, io, deps, paths)
      case 'kill-check':
        return await killCheckCommand(command, io, deps, paths)
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
