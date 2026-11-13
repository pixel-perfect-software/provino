import { parseArgs } from 'node:util'
import type { BenchLabel } from '@provino/types'
import { BenchError } from './errors.ts'
import { DEFAULT_RUN_TIMEOUT_MS, isTimerMs, MAX_RUN_TIMEOUT_MS } from './exec.ts'
import { DEFAULT_WORK_DIR, type InstructionsCommand, parseLegs } from './instructions/command.ts'
import { errorMessage } from './internal/guards.ts'
import { parseLabel, runsProblem } from './report.ts'
import { DEFAULT_COLD_RUNS, DEFAULT_WARM_RUNS } from './run-bench.ts'
import { parseSuiteName, RUNNERS, type RunnerName, type SuiteSpec } from './suites.ts'

/**
 * A parsed command line.
 * @public
 */
export type CliCommand =
  | { readonly command: 'help' }
  | { readonly command: 'generate'; readonly suite: SuiteSpec }
  | { readonly command: 'list-tests'; readonly dir: string }
  | {
      readonly command: 'check'
      readonly suite: SuiteSpec
      readonly runners: readonly RunnerName[]
      /** The longest one run may take, in milliseconds. */
      readonly timeoutMs: number
    }
  | {
      readonly command: 'run'
      readonly suite: SuiteSpec
      readonly runners: readonly RunnerName[]
      readonly warm: number
      readonly cold: number
      readonly label: BenchLabel
      readonly out: string | undefined
      readonly machineId: string | undefined
      /** The longest one run may take, in milliseconds. */
      readonly timeoutMs: number
    }
  | {
      readonly command: 'kill-check'
      readonly label: BenchLabel
      /** Run Jest in Provino's place: the gate's plumbing, never a quotable record. */
      readonly dryRun: boolean
      readonly out: string | undefined
      readonly machineId: string | undefined
      /** The longest one run may take, in milliseconds. */
      readonly timeoutMs: number
    }
  | InstructionsCommand

/**
 * The usage text.
 * @public
 */
export const USAGE: string = `provino-bench: Provino's benchmark protocol (Track 12 R5)

Usage:
  provino-bench generate <suite>
  provino-bench check <suite> --runner jest [--runner vitest] [--runner provino] [--timeout ${DEFAULT_RUN_TIMEOUT_MS / 60_000}]
  provino-bench run <suite> --runner jest|vitest|provino [--runner ...]
                    [--warm ${DEFAULT_WARM_RUNS}] [--cold ${DEFAULT_COLD_RUNS}] [--label local|desktop|pinned]
                    [--timeout ${DEFAULT_RUN_TIMEOUT_MS / 60_000}] [--out <file>] [--machine-id <id>]
  provino-bench kill-check [--label local|desktop|pinned] [--dry-run] [--out <file>]
                    [--machine-id <id>] [--timeout ${DEFAULT_RUN_TIMEOUT_MS / 60_000}]
  provino-bench list-tests <project dir>
  provino-bench instructions [--legs a,b] [--baseline <record>] [--out <file>] [--runs 1]
                    [--wall-runs 5] [--plant] [--no-cachegrind] [--no-signals] [--no-build]
                    [--sha <commit>] [--work-dir <dir>] [--summary-file <file>]

Suites: app-N, mock-heavy-N (N from 1 to 9999), isolate-heavy.
Runners: jest, vitest, and provino, which runs the provino bin on the suite's jest/ tree (all cores
  but one, the default) at isolation registry, with its results cache kept (it only orders files).
  \`check\` requires every test to pass; with --runner jest in the same check it also requires
  Provino's per-test statuses to equal Jest's.
list-tests: U2. Jest's --listTests --json and \`provino jest --listTests --json\` in a project directory
  (its own Jest when it has one), compared as sets. Exit 0 when they are the same set, 1 when not.
kill-check: Track 12 R6 on the R6 suite set: Provino against Jest, warm and cold, with the 10 warm and
  5 cold runs R6 fixes (so no --warm or --cold), plus registry/none on app-500. Suites that can't run
  yet print PENDING. The verdict is PROVISIONAL unless the label is pinned and every suite ran. Exit
  0 when no measured check failed, which on a PROVISIONAL verdict is not a GO decision; 1 for NO-GO,
  or when no verdict was reached (a refusal or a failure: it prints an error and no VERDICT line).
  --dry-run runs Jest in Provino's place, so every ratio is about 1.0 and the verdict is NO-GO; it
  needs --label local and is never a result, and its exit 1 says nothing about the plumbing.
instructions: T12.13's regression guard, with T2.12's, T5.14's and T3.12's. Each leg (the app-50,
  mock-heavy-50 and isolate-heavy suites in one inline worker; the loader's e2e fixture; core's
  workload; transform, hoist, resolve and the warm transform cache over fixed corpora) runs on the
  built packages under valgrind cachegrind with V8 --single-threaded --no-opt --predictable, and its
  instruction count is compared with --baseline (a record from main): +1.5% flags a suite or the
  loader leg, +20% core and the T3.12 legs. Wall times print as local signals. The record goes to
  .results/. Linux only (valgrind); --no-cachegrind gives the wall signals anywhere. --plant shows
  a real +2% rise flagged and a +1% one not. Exit 1 when a leg regressed or failed.
Options: each applies only to the commands above that show it.
  --warm, --cold   Timed runs per subject: whole numbers of 1 or more. The R5 protocol is
                   ${DEFAULT_WARM_RUNS} warm and ${DEFAULT_COLD_RUNS} cold. desktop and pinned records need at least that
                   many; a local run with fewer prints a WARNING in its summary.
  --timeout        Minutes one run may take (default ${DEFAULT_RUN_TIMEOUT_MS / 60_000}, at most ${Math.floor(MAX_RUN_TIMEOUT_MS / 60_000)}). A run that takes
                   longer has its whole process group killed and is a failed run (exit 124).
  --out            Where the record goes. It must not exist yet: a record is never overwritten.
                   Default .results/<time>-<suite>-<sha7>.json in the bench package.
Records are labelled local by default; only pinned numbers decide GO or appear publicly. desktop
and pinned refuse a dirty git tree; a local record on one says dirty.`

const options = {
  'dry-run': { type: 'boolean' },
  runner: { type: 'string', multiple: true },
  warm: { type: 'string' },
  cold: { type: 'string' },
  label: { type: 'string' },
  out: { type: 'string' },
  'machine-id': { type: 'string' },
  timeout: { type: 'string' },
  legs: { type: 'string' },
  baseline: { type: 'string' },
  runs: { type: 'string' },
  'wall-runs': { type: 'string' },
  plant: { type: 'boolean' },
  'no-cachegrind': { type: 'boolean' },
  'no-signals': { type: 'boolean' },
  'no-build': { type: 'boolean' },
  sha: { type: 'string' },
  'work-dir': { type: 'string' },
  'summary-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

type OptionName = keyof typeof options

// Which options each command reads. Anything else on the command line is an error, not ignored.
const COMMAND_OPTIONS: Readonly<
  Record<
    'generate' | 'list-tests' | 'check' | 'run' | 'kill-check' | 'instructions',
    readonly OptionName[]
  >
> = {
  generate: [],
  'list-tests': [],
  check: ['runner', 'timeout'],
  run: ['runner', 'warm', 'cold', 'label', 'out', 'machine-id', 'timeout'],
  'kill-check': ['label', 'dry-run', 'out', 'machine-id', 'timeout'],
  instructions: [
    'legs',
    'baseline',
    'out',
    'runs',
    'wall-runs',
    'plant',
    'no-cachegrind',
    'no-signals',
    'no-build',
    'sha',
    'work-dir',
    'summary-file',
  ],
}

function read(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options, allowPositionals: true })
  } catch (cause) {
    throw new BenchError('BENCH_USAGE', errorMessage(cause), { cause })
  }
}

function usage(message: string): BenchError {
  return new BenchError('BENCH_USAGE', message)
}

// `Number()` would also take ` 7`, `1e1`, `0x10` and `1e21`; a count is plain decimal digits.
function count(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw usage(`${flag} must be a positive whole number, like 10; got ${JSON.stringify(value)}`)
  }
  return parsed
}

function timeoutMs(value: string | undefined): number {
  const ms = count(value, DEFAULT_RUN_TIMEOUT_MS / 60_000, '--timeout') * 60_000
  if (!isTimerMs(ms, 60_000)) {
    throw usage(`--timeout must be at most ${Math.floor(MAX_RUN_TIMEOUT_MS / 60_000)} minutes`)
  }
  return ms
}

function nonEmpty(value: string | undefined, flag: string): string | undefined {
  if (value !== undefined && value.trim() === '') throw usage(`${flag} must not be empty`)
  return value
}

function onlyOptions(
  command: keyof typeof COMMAND_OPTIONS,
  values: Readonly<Partial<Record<OptionName, unknown>>>,
): void {
  const allowed: readonly string[] = COMMAND_OPTIONS[command]
  for (const name of Object.keys(values)) {
    if (name !== 'help' && !allowed.includes(name)) {
      throw usage(`--${name} does not apply to ${command}`)
    }
  }
}

function runners(values: readonly string[] | undefined): readonly RunnerName[] {
  if (values === undefined || values.length === 0) throw usage('pass at least one --runner')
  const parsed: RunnerName[] = []
  for (const value of values) {
    const runner = RUNNERS.find((candidate) => candidate === value)
    if (runner === undefined) throw usage(`--runner must be ${RUNNERS.join(' or ')}; got ${value}`)
    if (!parsed.includes(runner)) parsed.push(runner)
  }
  return parsed
}

// What `run` and `kill-check` share: the record's label, where it goes, its machine id and the run
// timeout. The caller parses the label first (it may need it before these).
function recordOptions(
  values: {
    readonly out?: string | undefined
    readonly 'machine-id'?: string | undefined
    readonly timeout?: string | undefined
  },
  label: BenchLabel,
) {
  return {
    label,
    out: nonEmpty(values.out, '--out'),
    machineId: nonEmpty(values['machine-id'], '--machine-id'),
    timeoutMs: timeoutMs(values.timeout),
  }
}

/**
 * Parses the arguments after `node cli.ts`.
 * @public
 */
export function parseCli(argv: readonly string[]): CliCommand {
  const { values, positionals } = read(argv)
  const [command, suiteName, ...extra] = positionals
  if (values.help || command === undefined || command === 'help') return { command: 'help' }
  if (command === 'kill-check') {
    // The suite set is R6's, not the caller's.
    if (suiteName !== undefined) throw usage(`kill-check takes no suite; got ${suiteName}`)
    onlyOptions(command, values)
    const label = parseLabel(values.label ?? 'local')
    const dryRun = values['dry-run'] === true
    if (dryRun && label !== 'local') {
      throw usage(
        `--dry-run needs --label local: a dry run is never a quotable record; got ${label}`,
      )
    }
    return { command, dryRun, ...recordOptions(values, label) }
  }
  if (command === 'instructions') {
    if (suiteName !== undefined) throw usage(`instructions takes no suite; got ${suiteName}`)
    onlyOptions(command, values)
    const sha = nonEmpty(values.sha, '--sha')
    if (sha !== undefined && !/^[0-9a-f]{7,40}$/.test(sha)) {
      throw usage(`--sha must be a commit's hex id; got ${JSON.stringify(sha)}`)
    }
    return {
      command,
      legs: parseLegs(values.legs),
      baseline: nonEmpty(values.baseline, '--baseline'),
      out: nonEmpty(values.out, '--out'),
      runs: count(values.runs, 1, '--runs'),
      wallRuns: count(values['wall-runs'], 5, '--wall-runs'),
      cachegrind: values['no-cachegrind'] !== true,
      plant: values.plant === true,
      signals: values['no-signals'] !== true,
      build: values['no-build'] !== true,
      sha,
      workDir: nonEmpty(values['work-dir'], '--work-dir') ?? DEFAULT_WORK_DIR,
      summaryFile: nonEmpty(values['summary-file'], '--summary-file'),
    }
  }
  if (command === 'list-tests') {
    onlyOptions(command, values)
    if (suiteName === undefined) throw usage('list-tests needs a project directory')
    if (extra.length > 0) throw usage(`unexpected argument ${extra[0]}`)
    return { command, dir: suiteName }
  }
  if (suiteName === undefined) throw usage(`${command} needs a suite`)
  if (extra.length > 0) throw usage(`unexpected argument ${extra[0]}`)
  const suite = parseSuiteName(suiteName)
  switch (command) {
    case 'generate':
      onlyOptions(command, values)
      return { command, suite }
    case 'check':
      onlyOptions(command, values)
      return {
        command,
        suite,
        runners: runners(values.runner),
        timeoutMs: timeoutMs(values.timeout),
      }
    case 'run': {
      onlyOptions(command, values)
      const warm = count(values.warm, DEFAULT_WARM_RUNS, '--warm')
      const cold = count(values.cold, DEFAULT_COLD_RUNS, '--cold')
      const label = parseLabel(values.label ?? 'local')
      // The label's policy sets the floor (the R5 protocol for any record that can be quoted).
      const tooFew = runsProblem(label, 'warm', warm) ?? runsProblem(label, 'cold', cold)
      if (tooFew !== undefined) throw usage(`${tooFew}; got --warm ${warm} --cold ${cold}`)
      return {
        command,
        suite,
        runners: runners(values.runner),
        warm,
        cold,
        ...recordOptions(values, label),
      }
    }
    default:
      throw usage(`unknown command ${command}`)
  }
}
