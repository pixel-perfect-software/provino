import { parseArgs } from 'node:util'
import type { BenchLabel } from '@provino/types'
import { BenchError } from './errors.ts'
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
                    [--out <file>] [--machine-id <id>]

Suites: app-N, mock-heavy-N (N from 1 to 9999), isolate-heavy.
Records are labelled local by default; only pinned numbers decide GO or appear publicly.`

const options = {
  runner: { type: 'string', multiple: true },
  warm: { type: 'string' },
  cold: { type: 'string' },
  label: { type: 'string' },
  out: { type: 'string' },
  'machine-id': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

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

function count(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw usage(`${flag} must be a positive integer`)
  return parsed
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
      return { command, suite }
    case 'check':
      return { command, suite, runners: runners(values.runner) }
    case 'run':
      return {
        command,
        suite,
        runners: runners(values.runner),
        warm: count(values.warm, DEFAULT_WARM_RUNS, '--warm'),
        cold: count(values.cold, DEFAULT_COLD_RUNS, '--cold'),
        label: parseLabel(values.label ?? 'local'),
        out: values.out,
        machineId: values['machine-id'],
      }
    default:
      throw usage(`unknown command ${command}`)
  }
}
