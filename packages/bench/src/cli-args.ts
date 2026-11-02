import { parseArgs } from 'node:util'
import type { BenchLabel } from '@provino/types'
import { BenchError } from './errors.ts'
import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS } from './exec.ts'
import { parseLabel } from './report.ts'
import { DEFAULT_COLD_RUNS, DEFAULT_WARM_RUNS } from './run-bench.ts'
import { parseSuiteName, RUNNERS, type RunnerName, type SuiteSpec } from './suites.ts'

/**
 * A parsed command line.
 * @public
 */
export type CliCommand =
  | { readonly command: 'help' }
  | { readonly command: 'generate'; readonly suite: SuiteSpec }
  | {
      readonly command: 'check'
      readonly suite: SuiteSpec
      readonly runners: readonly RunnerName[]
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

/**
 * The usage text.
 * @public
 */
export const USAGE: string = `provino-bench: Provino's benchmark protocol (Track 12 R5)

Usage:
  provino-bench generate <suite>
  provino-bench check <suite> --runner jest [--runner vitest]
  provino-bench run <suite> --runner jest|vitest [--runner ...]
                    [--warm ${DEFAULT_WARM_RUNS}] [--cold ${DEFAULT_COLD_RUNS}] [--label local|desktop|pinned]
                    [--timeout ${DEFAULT_RUN_TIMEOUT_MS / 60_000}] [--out <file>] [--machine-id <id>]

Suites: app-N, mock-heavy-N (N from 1 to 9999), isolate-heavy.
Options: each applies only to the commands above that show it.
  --warm, --cold   Timed runs per subject: whole numbers of 1 or more. The R5 protocol is
                   ${DEFAULT_WARM_RUNS} warm and ${DEFAULT_COLD_RUNS} cold. desktop and pinned records need at least that
                   many; a local run with fewer prints a WARNING in its summary.
  --timeout        Minutes one run may take (default ${DEFAULT_RUN_TIMEOUT_MS / 60_000}, at most ${Math.floor(MAX_RUN_TIMEOUT_MS / 60_000)}). A run that takes
                   longer has its whole process group killed and is kept as a failed run (exit 124).
  --out            Where the record goes. It must not exist yet: a record is never overwritten.
                   Default .results/<time>-<suite>-<sha7>.json in the bench package.
Records are labelled local by default; only pinned numbers decide GO or appear publicly. desktop
and pinned refuse a dirty git tree; a local record on one says dirty.`

const options = {
  runner: { type: 'string', multiple: true },
  warm: { type: 'string' },
  cold: { type: 'string' },
  label: { type: 'string' },
  out: { type: 'string' },
  'machine-id': { type: 'string' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

type OptionName = keyof typeof options

// Which options each command reads. Anything else on the command line is an error, not ignored.
const COMMAND_OPTIONS: Readonly<Record<'generate' | 'check' | 'run', readonly OptionName[]>> = {
  generate: [],
  check: ['runner'],
  run: ['runner', 'warm', 'cold', 'label', 'out', 'machine-id', 'timeout'],
}

function read(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options, allowPositionals: true })
  } catch (cause) {
    throw new BenchError('BENCH_USAGE', cause instanceof Error ? cause.message : String(cause), {
      cause,
    })
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
  if (ms > MAX_RUN_TIMEOUT_MS) {
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

/**
 * Parses the arguments after `node cli.ts`.
 * @public
 */
export function parseCli(argv: readonly string[]): CliCommand {
  const { values, positionals } = read(argv)
  const [command, suiteName, ...extra] = positionals
  if (values.help || command === undefined || command === 'help') return { command: 'help' }
  if (suiteName === undefined) throw usage(`${command} needs a suite`)
  if (extra.length > 0) throw usage(`unexpected argument ${extra[0]}`)
  const suite = parseSuiteName(suiteName)
  switch (command) {
    case 'generate':
      onlyOptions(command, values)
      return { command, suite }
    case 'check':
      onlyOptions(command, values)
      return { command, suite, runners: runners(values.runner) }
    case 'run': {
      onlyOptions(command, values)
      const warm = count(values.warm, DEFAULT_WARM_RUNS, '--warm')
      const cold = count(values.cold, DEFAULT_COLD_RUNS, '--cold')
      const label = parseLabel(values.label ?? 'local')
      // The R5 protocol is the floor for any record that can be quoted. A local run may be shorter;
      // its summary says so.
      if (label !== 'local' && (warm < DEFAULT_WARM_RUNS || cold < DEFAULT_COLD_RUNS)) {
        throw usage(
          `a ${label} record needs at least ${DEFAULT_WARM_RUNS} warm and ${DEFAULT_COLD_RUNS} cold runs (the R5 protocol); got --warm ${warm} --cold ${cold}`,
        )
      }
      return {
        command,
        suite,
        runners: runners(values.runner),
        warm,
        cold,
        label,
        out: nonEmpty(values.out, '--out'),
        machineId: nonEmpty(values['machine-id'], '--machine-id'),
        timeoutMs: timeoutMs(values.timeout),
      }
    }
    default:
      throw usage(`unknown command ${command}`)
  }
}
