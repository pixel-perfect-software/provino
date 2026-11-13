import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { ExitCode } from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { PoolKind } from '@provino/types'
import { run } from '../run.ts'
import type { ReporterChoice, RunOptions } from '../types.ts'
import { detectProject } from './detect.ts'
import { runJestCommand } from './jest-command.ts'
import { quickAnswer } from './quick.ts'
import { BUILT_IN_REPORTERS } from './reporters.ts'
import { USAGE } from './usage.ts'
import { UsageError } from './usage-error.ts'

/** What the process exits with for an error that is a bug in Provino. */
const INTERNAL_ERROR_EXIT = 1

const POOL_KINDS: readonly PoolKind[] = ['forks', 'threads', 'inline']

/**
 * What a command line asks for.
 * @internal
 */
export type RunCommand =
  | { readonly type: 'help' }
  | { readonly type: 'run'; readonly options: RunOptions }
  | { readonly type: 'jest'; readonly args: readonly string[] }
  | { readonly type: 'bare'; readonly args: readonly string[] }

function isPoolKind(value: string): value is PoolKind {
  return POOL_KINDS.some((kind) => kind === value)
}

function parseMaxWorkers(text: string): number {
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new UsageError(`--maxWorkers must be a whole number of at least 1 (got "${text}")`)
  }
  return Number(text)
}

/** `--reporter` names, with `--outputFile` going to the `normalized-json` one. */
function parseReporters(
  names: readonly string[],
  outputFile: string | undefined,
): readonly ReporterChoice[] {
  for (const [index, name] of names.entries()) {
    if (names.indexOf(name) !== index) {
      throw new UsageError(`--reporter ${name} is given more than once`)
    }
    if (!BUILT_IN_REPORTERS.includes(name)) {
      throw new UsageError(
        `unknown reporter "${name}" (use ${BUILT_IN_REPORTERS.join(' or ')}) for --reporter`,
      )
    }
  }
  if (outputFile !== undefined && !names.includes('normalized-json')) {
    throw new UsageError('--outputFile needs --reporter normalized-json')
  }
  return names.map((name): ReporterChoice => {
    if (name === 'normalized-json') {
      return outputFile === undefined ? name : [name, { outputFile }]
    }
    return 'default'
  })
}

/**
 * Parses the arguments after `run`. A flag it doesn't know, a missing or bad value, or a missing
 * `--config` is a `UsageError`.
 * @internal
 */
export function parseRunArgs(
  args: readonly string[],
): Extract<RunCommand, { readonly type: 'help' | 'run' }> {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(args.map(longFormOfShortWithEquals))
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), { cause: error })
  }
  const { values } = parsed
  if (values.help === true) return { type: 'help' }
  if (values.config === undefined) throw new UsageError('--config <file> is required')
  if (values.pool !== undefined && !isPoolKind(values.pool)) {
    throw new UsageError(`--pool must be one of ${POOL_KINDS.join(', ')} (got "${values.pool}")`)
  }
  const names = values.reporter ?? []
  const reporters = parseReporters(names, values.outputFile)
  const options: RunOptions = {
    config: values.config,
    ...(values.maxWorkers === undefined ? {} : { maxWorkers: parseMaxWorkers(values.maxWorkers) }),
    ...(values.pool === undefined ? {} : { pool: values.pool }),
    ...(names.length === 0 ? {} : { reporters }),
    ...(values.ci === true ? { ci: true } : {}),
    ...(values.updateSnapshot === true ? { updateSnapshot: true } : {}),
    ...(values.passWithNoTests === true ? { passWithNoTests: true } : {}),
    ...(values.testNamePattern === undefined ? {} : { testNamePattern: values.testNamePattern }),
    ...(values['no-cache'] === true ? { cache: false } : {}),
  }
  return { type: 'run', options }
}

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  maxWorkers: { type: 'string' },
  pool: { type: 'string' },
  reporter: { type: 'string', multiple: true },
  outputFile: { type: 'string' },
  testNamePattern: { type: 'string', short: 't' },
  ci: { type: 'boolean' },
  updateSnapshot: { type: 'boolean', short: 'u' },
  passWithNoTests: { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig

/** The long name of each string option's short one: `t` is `testNamePattern`. */
const LONG_OF_SHORT: ReadonlyMap<string, string> = new Map(
  Object.entries<ParseArgsOptionsConfig[string]>(OPTIONS).flatMap(([long, option]) =>
    option.type === 'string' && option.short !== undefined ? [[option.short, long]] : [],
  ),
)

/**
 * `parseArgs` keeps the `=` of `-t=a` in the value (`=a`), so `-<short>=<v>` becomes the long
 * option, for every string option with a short name. Only that exact form: `-ta` and `-t a` are
 * already right.
 */
function longFormOfShortWithEquals(arg: string): string {
  if (arg.length >= 3 && arg.startsWith('-') && arg[2] === '=') {
    const long = LONG_OF_SHORT.get(arg.slice(1, 2))
    if (long !== undefined) return `--${long}=${arg.slice(3)}`
  }
  return arg
}

function parse(args: readonly string[]) {
  return parseArgs({ args: [...args], allowPositionals: false, strict: true, options: OPTIONS })
}

/**
 * Where the command reads and writes. Every part defaults to the process's.
 * @internal
 */
export interface CliIo {
  readonly stdout?: TextSink
  readonly stderr?: NodeJS.WritableStream
  readonly cwd?: string
}

/** What `command` and its `args` ask for. */
function parseCommand(command: string | undefined, args: readonly string[]): RunCommand {
  if (command === undefined) return { type: 'bare', args: [] }
  if (command === 'run') return parseRunArgs(args)
  if (command === 'jest') return { type: 'jest', args }
  if (command === 'vitest') {
    throw new UsageError(
      'provino vitest is not available yet: the Vitest dialect has no config reader or command line (T11.15, T11.16, Phase 2)',
    )
  }
  // Anything else starting with a dash is the bare form: `provino --dialect jest -t foo`.
  if (command.startsWith('-')) return { type: 'bare', args: [command, ...args] }
  throw new UsageError(`unknown command "${command}"`)
}

/**
 * The bare `provino` form: `--dialect <name>` picks the runner, else the project says which it is
 * (`detectProject`); a `provino.config.*` runs as `provino run --config <it>`.
 */
async function runBare(args: readonly string[], io: CliIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd()
  const rest: string[] = []
  let dialect: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === '--dialect') {
      dialect = args[++index]
      if (dialect === undefined) throw new UsageError('--dialect needs jest or vitest')
    } else if (arg.startsWith('--dialect=')) {
      dialect = arg.slice('--dialect='.length)
    } else {
      rest.push(arg)
    }
  }
  if (dialect !== undefined && dialect !== 'jest' && dialect !== 'vitest') {
    throw new UsageError(`--dialect must be jest or vitest (got "${dialect}")`)
  }
  const found = await detectProject(cwd, dialect)
  if (found.kind === 'vitest') {
    throw new UsageError(
      'this is a Vitest project, and provino vitest is not available yet (T11.15, T11.16, Phase 2)',
    )
  }
  if (found.kind === 'jest') return runBareJest(rest, io)
  const parsed = parseRunArgs(['--config', found.config, ...rest])
  if (parsed.type === 'help') return helpExit(io)
  return (await run({ ...parsed.options, ...ioOptions(io) })).exitCode
}

function runBareJest(args: readonly string[], io: CliIo): Promise<number> {
  return runJestCommand(args, {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    cwd: io.cwd ?? process.cwd(),
  })
}

async function helpExit(io: CliIo): Promise<number> {
  await (io.stdout ?? process.stdout).write(USAGE)
  return ExitCode.Pass
}

function ioOptions(io: CliIo): Pick<RunOptions, 'stdout' | 'stderr' | 'cwd'> {
  return {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    ...(io.cwd === undefined ? {} : { cwd: io.cwd }),
  }
}

/**
 * The `provino` command: dispatches on the first argument (`jest`, `vitest`, `run`, or none, which
 * detects the project) and resolves with the exit code. It never rejects and never exits the process.
 * Bad usage prints the message and the usage text to stderr and is exit code 2; `--help` prints
 * the usage text to stdout; a bug in Provino prints its stack and is exit code 1.
 * @internal
 */
export async function main(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr
  try {
    // The first-argument --version, --help and -h: the same answer the bin gives before it imports this.
    const quick = quickAnswer(argv)
    if (quick !== undefined) {
      await (io.stdout ?? process.stdout).write(quick)
      return ExitCode.Pass
    }
    const [command, ...args] = argv
    const parsed = parseCommand(command, args)
    if (parsed.type === 'help') return await helpExit(io)
    if (parsed.type === 'bare') return await runBare(parsed.args, io)
    if (parsed.type === 'jest') return await runBareJest(parsed.args, io)
    return (await run({ ...parsed.options, ...ioOptions(io) })).exitCode
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`Provino: ${error.message}\n\n${USAGE}`)
      return ExitCode.UsageError
    }
    stderr.write(
      `Provino: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    return INTERNAL_ERROR_EXIT
  }
}
