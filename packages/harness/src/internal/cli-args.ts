import { type ParseArgsConfig, parseArgs } from 'node:util'
import type { DiffOptions } from '../diff.ts'
import { HarnessError } from '../errors.ts'
import type { SubjectRunner } from '../run-subject.ts'
import { ISO_DATE } from './guards.ts'

/**
 * `record`: what the command line asked for.
 * @internal
 */
export interface RecordCommand {
  readonly command: 'record'
  /** Compare with the committed goldens instead of writing them. */
  readonly check: boolean
  readonly keepWorkDir: boolean
  /** Fixture directories, or directories of fixtures. Empty means every fixture under `fixtures/`. */
  readonly fixtures: readonly string[]
}

/**
 * `diff`: two `NormalizedRun` files and how to judge them.
 * @internal
 */
export interface DiffCommand {
  readonly command: 'diff'
  readonly ref: string
  readonly cand: string
  readonly mode: DiffOptions['messageMode']
  readonly exclusions?: string
  readonly flaky?: string
  readonly console: boolean
  /** The lowest status parity that passes. */
  readonly min: number
  /** The most diffs no rule explains that pass; no limit when absent. */
  readonly maxDiffs?: number
  /** The largest share of the reference's tests that exclusion rules may remove (R2: 2%). */
  readonly maxExcluded: number
  /** Lifts R2's expiry rule and the excluded-share cap (DECISIONS D30). */
  readonly calibration: boolean
  readonly today?: string
}

/**
 * `convert`: one runner's raw output to a `NormalizedRun` file.
 * @internal
 */
export interface ConvertCommand {
  readonly command: 'convert'
  readonly runner: SubjectRunner
  readonly input: string
  readonly sidecar?: string
  readonly root: string
  readonly suite: string
  readonly out: string
  readonly runnerVersion?: string
}

/**
 * `self-test`: the sample under both runners, and optionally Provino.
 * @internal
 */
export interface SelfTestCommand {
  readonly command: 'self-test'
  readonly candidate?: 'provino'
  /** Where the Provino report goes. */
  readonly out?: string
  readonly writeRecorded: boolean
  readonly keepWorkDir: boolean
  readonly today?: string
}

/**
 * `policy-diff`: the two dialects, in print order (T1.8).
 * @internal
 */
export interface PolicyDiffCommand {
  readonly command: 'policy-diff'
  readonly a: 'jest' | 'vitest'
  readonly b: 'jest' | 'vitest'
}

/**
 * What the command line asked for.
 * @internal
 */
export type HarnessCommand =
  | RecordCommand
  | DiffCommand
  | ConvertCommand
  | SelfTestCommand
  | PolicyDiffCommand

/**
 * The usage text.
 * @internal
 */
export const USAGE = `Usage: provino-harness <command> [options]

  record [--check] [--keep] [<fixture dir>...]
           Run Jest and Vitest over each fixture and write __goldens__/<profile>.json.
           A directory is a fixture or holds fixtures (fixtures/runtime). With no directory,
           every fixture under packages/harness/fixtures/.
           --check  Compare with the committed goldens instead of writing them; exit 1 on drift.
           --keep   Keep the work directories under packages/harness/.record/.

  diff --ref <run> --cand <run> [--mode exact|matcher|none] [--exclusions <file>]
       [--flaky <file>] [--console] [--min <share>] [--max-diffs <n>]
       [--max-excluded <share>] [--calibration] [--today <YYYY-MM-DD>]
           Compare two NormalizedRun files (Track 12 R1, R2). The ParityReport goes to stdout
           as JSON and a summary table to stderr. Exit 0 on a pass; 1 when status parity is
           below --min (default 1), there are more than --max-diffs unexplained diffs,
           exclusions remove more than --max-excluded of the reference's tests (default 0.02),
           or nothing was compared; 2 on bad usage or an unreadable file. Every exclusion must
           expire within 90 days of --today; --calibration lifts that and the cap.

  convert --runner jest|vitest|provino --input <raw> [--sidecar <file>] --root <dir>
          --suite <id> --out <file> [--runner-version <v>]
           Convert one runner's JSON (and its sidecar console file) to a NormalizedRun.

  self-test [--candidate provino] [--out <file>] [--write-recorded] [--keep]
            [--today <YYYY-MM-DD>]
           Run packages/harness/sample under Jest and Vitest, check the recording and the
           calibrated parity (Track 12 T12.6). --candidate provino also runs Provino on the
           sample and writes its ParityReport to --out; it prints pass or fail only.
           --write-recorded rewrites sample/__recorded__ from this run.

  policy-diff <jest|vitest> <jest|vitest>
           Print every policy key, hoisting rule and global name where the two dialects
           differ (T1.8).
`

function usage(message: string, cause?: unknown): HarnessError {
  return new HarnessError('HARNESS_USAGE', message, cause === undefined ? undefined : { cause })
}

function readArguments<T extends NonNullable<ParseArgsConfig['options']>>(
  argv: readonly string[],
  options: T,
  allowPositionals: boolean,
) {
  try {
    return parseArgs({ args: [...argv], allowPositionals, options, strict: true })
  } catch (cause) {
    throw usage(cause instanceof Error ? cause.message : 'bad arguments', cause)
  }
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw usage(`${flag} is required`)
  return value
}

// A plain decimal, so `Number`'s other spellings (`0x1`, `1e0`, `0b1`, `1e-400`) aren't shares.
const DECIMAL = /^\d+(?:\.\d+)?$/

function share(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!DECIMAL.test(value) || number > 1) {
    throw usage(`${flag} must be a number from 0 to 1, got "${value}"`)
  }
  return number
}

function count(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw usage(`${flag} must be a whole number, got "${value}"`)
  }
  return number
}

function date(value: string | undefined): { today?: string } {
  if (value === undefined) return {}
  if (!ISO_DATE.test(value)) throw usage(`--today must be a YYYY-MM-DD date, got "${value}"`)
  return { today: value }
}

function parseRecord(argv: readonly string[]): RecordCommand {
  const { values, positionals } = readArguments(
    argv,
    { check: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false } },
    true,
  )
  return { command: 'record', check: values.check, keepWorkDir: values.keep, fixtures: positionals }
}

const MODES: readonly DiffOptions['messageMode'][] = ['exact', 'matcher', 'none']

function parseDiff(argv: readonly string[]): DiffCommand {
  const { values } = readArguments(
    argv,
    {
      ref: { type: 'string' },
      cand: { type: 'string' },
      mode: { type: 'string', default: 'exact' },
      exclusions: { type: 'string' },
      flaky: { type: 'string' },
      console: { type: 'boolean', default: false },
      min: { type: 'string' },
      'max-diffs': { type: 'string' },
      'max-excluded': { type: 'string' },
      calibration: { type: 'boolean', default: false },
      today: { type: 'string' },
    },
    false,
  )
  const mode = MODES.find((m) => m === values.mode)
  if (mode === undefined) throw usage(`--mode must be exact, matcher or none, got "${values.mode}"`)
  const maxDiffs = count(values['max-diffs'], '--max-diffs')
  return {
    command: 'diff',
    ref: required(values.ref, '--ref'),
    cand: required(values.cand, '--cand'),
    mode,
    ...(values.exclusions === undefined ? {} : { exclusions: values.exclusions }),
    ...(values.flaky === undefined ? {} : { flaky: values.flaky }),
    console: values.console,
    min: share(values.min, '--min', 1),
    ...(maxDiffs === undefined ? {} : { maxDiffs }),
    maxExcluded: share(values['max-excluded'], '--max-excluded', 0.02),
    calibration: values.calibration,
    ...date(values.today),
  }
}

const RUNNERS: readonly SubjectRunner[] = ['jest', 'vitest', 'provino']

function parseConvert(argv: readonly string[]): ConvertCommand {
  const { values } = readArguments(
    argv,
    {
      runner: { type: 'string' },
      input: { type: 'string' },
      sidecar: { type: 'string' },
      root: { type: 'string' },
      suite: { type: 'string' },
      out: { type: 'string' },
      'runner-version': { type: 'string' },
    },
    false,
  )
  const runner = RUNNERS.find((r) => r === values.runner)
  if (runner === undefined) {
    throw usage(`--runner must be jest, vitest or provino, got "${values.runner ?? ''}"`)
  }
  if (runner === 'provino' && values.sidecar !== undefined) {
    throw usage('--sidecar is for Jest and Vitest: Provino writes its console output itself')
  }
  return {
    command: 'convert',
    runner,
    input: required(values.input, '--input'),
    ...(values.sidecar === undefined ? {} : { sidecar: values.sidecar }),
    root: required(values.root, '--root'),
    suite: required(values.suite, '--suite'),
    out: required(values.out, '--out'),
    ...(values['runner-version'] === undefined ? {} : { runnerVersion: values['runner-version'] }),
  }
}

function parseSelfTest(argv: readonly string[]): SelfTestCommand {
  const { values } = readArguments(
    argv,
    {
      candidate: { type: 'string' },
      out: { type: 'string' },
      'write-recorded': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      today: { type: 'string' },
    },
    false,
  )
  if (values.candidate !== undefined && values.candidate !== 'provino') {
    throw usage(`--candidate must be provino, got "${values.candidate}"`)
  }
  if (values.out !== undefined && values.candidate === undefined) {
    throw usage('--out is the Provino report: it needs --candidate provino')
  }
  return {
    command: 'self-test',
    ...(values.candidate === undefined ? {} : { candidate: 'provino' as const }),
    ...(values.out === undefined ? {} : { out: values.out }),
    writeRecorded: values['write-recorded'],
    keepWorkDir: values.keep,
    ...date(values.today),
  }
}

function parsePolicyDiff(argv: readonly string[]): PolicyDiffCommand {
  const isDialect = (name: string | undefined): name is 'jest' | 'vitest' =>
    name === 'jest' || name === 'vitest'
  const [a, b, ...rest] = argv
  if (!isDialect(a) || !isDialect(b) || rest.length > 0) {
    throw usage('policy-diff takes two dialects: jest or vitest')
  }
  return { command: 'policy-diff', a, b }
}

/**
 * Parses `provino-harness` arguments: the command first, then its options. Throws a
 * `HARNESS_USAGE` error on anything else.
 * @internal
 */
export function parseCommandLine(argv: readonly string[]): HarnessCommand {
  const [command, ...rest] = argv
  switch (command) {
    case 'record':
      return parseRecord(rest)
    case 'diff':
      return parseDiff(rest)
    case 'convert':
      return parseConvert(rest)
    case 'self-test':
      return parseSelfTest(rest)
    case 'policy-diff':
      return parsePolicyDiff(rest)
    case undefined:
      throw usage('missing command')
    default:
      throw usage(
        command.startsWith('-')
          ? `the command comes first, got "${command}"`
          : `unknown command "${command}"`,
      )
  }
}
