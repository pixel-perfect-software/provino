import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { ExitCode } from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { PoolKind } from '@provino/types'
import { run } from '../run.ts'
import type { ReporterChoice, RunOptions } from '../types.ts'
import { detectProject } from './detect.ts'
import { runJestCommand } from './jest-command.ts'
import { quickAnswer } from './quick.ts'
import { BUILT_IN_REPORTERS, DOCUMENT_REPORTERS } from './reporters.ts'
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
  | { readonly type: 'run'; readonly options: RunOptions; readonly forceExit?: true }
  | { readonly type: 'jest'; readonly args: readonly string[] }
  | { readonly type: 'bare'; readonly args: readonly string[] }

function isPoolKind(value: string): value is PoolKind {
  return POOL_KINDS.some((kind) => kind === value)
}

/**
 * `--bail` with no count is `--bail=1`, and `--bail 2` is `--bail=2` (`provino run` takes no
 * positional arguments): `parseArgs` has no option with an optional value.
 */
function bailWithCount(args: readonly string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg !== '--bail') {
      out.push(arg)
      continue
    }
    const next = args[index + 1]
    if (next !== undefined && /^\d+$/.test(next)) {
      out.push(`--bail=${next}`)
      index++
    } else {
      out.push('--bail=1')
    }
  }
  return out
}

/** The bytes in each unit a `--workerMemoryLimit` may name: Jest's, decimal for `kb`/`mb`/`gb`, binary for `kib`/`mib`/`gib`. */
const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
}

/** A number of bytes, with an optional unit after it (any case). */
function parseBytes(text: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?$/i.exec(text)
  if (match === null) {
    throw new UsageError(
      `${flag} must be a number of bytes, such as 536870912 or 512MB (got "${text}")`,
    )
  }
  const factor = BYTE_UNITS[(match[2] ?? 'b').toLowerCase()] ?? 1
  return Math.floor(Number(match[1]) * factor)
}

/** A whole number of at least `min` (1, or 0 where 0 is off), in digits only. */
function parseWhole(text: string, flag: string, min: 0 | 1 = 1): number {
  const digits = min === 0 ? /^\d+$/ : /^[1-9]\d*$/
  if (!digits.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new UsageError(`${flag} must be a whole number of at least ${min} (got "${text}")`)
  }
  return Number(text)
}

/** One `--reporter` name as the choice it stands for; `outputFile` goes to a document reporter. */
function choiceFor(name: string, outputFile: string | undefined): ReporterChoice {
  switch (name) {
    case 'json':
    case 'normalized-json':
      return outputFile === undefined ? name : [name, { outputFile }]
    case 'junit':
      return outputFile === undefined ? name : [name, { outputFile }]
    case 'default':
    case 'verbose':
    case 'dot':
    case 'agent':
    case 'github-actions':
      return name
    default:
      throw unknownReporter(name)
  }
}

/** The error for a `--reporter` name that is no built-in. */
function unknownReporter(name: string): UsageError {
  return new UsageError(
    `unknown reporter "${name}" (use ${BUILT_IN_REPORTERS.join(', ')}) for --reporter`,
  )
}

/**
 * `--reporter` names, with `--outputFile` going to the one reporter that writes a document
 * (`json`, `normalized-json` or `junit`). Every name is checked first, so a misspelt one is
 * named as such whatever else is wrong.
 */
function parseReporters(
  names: readonly string[],
  outputFile: string | undefined,
): readonly ReporterChoice[] {
  for (const [index, name] of names.entries()) {
    if (!BUILT_IN_REPORTERS.includes(name)) throw unknownReporter(name)
    if (names.indexOf(name) !== index) {
      throw new UsageError(`--reporter ${name} is given more than once`)
    }
  }
  if (outputFile !== undefined) {
    const writers = names.filter((name) => DOCUMENT_REPORTERS.includes(name))
    if (writers.length === 0) {
      throw new UsageError('--outputFile needs --reporter json, normalized-json or junit')
    }
    if (writers.length > 1) {
      throw new UsageError(
        `--outputFile is one path, and ${writers.join(' and ')} each write a document: name one of them, or give each its outputFile in a script`,
      )
    }
  }
  return names.map((name) =>
    choiceFor(name, DOCUMENT_REPORTERS.includes(name) ? outputFile : undefined),
  )
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
    parsed = parse(bailWithCount(args).map(longFormOfShortWithEquals))
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
    ...(values.maxWorkers === undefined
      ? {}
      : { maxWorkers: parseWhole(values.maxWorkers, '--maxWorkers') }),
    ...(values.pool === undefined ? {} : { pool: values.pool }),
    ...(names.length === 0 ? {} : { reporters }),
    ...(values.ci === true ? { ci: true } : {}),
    ...(values.updateSnapshot === true ? { updateSnapshot: true } : {}),
    ...(values.passWithNoTests === true ? { passWithNoTests: true } : {}),
    ...(values.testNamePattern === undefined ? {} : { testNamePattern: values.testNamePattern }),
    ...(values['no-cache'] === true ? { cache: false } : {}),
    ...(values.bail === undefined ? {} : { bail: parseWhole(values.bail, '--bail', 0) }),
    ...(values.detectOpenHandles === true ? { detectOpenHandles: true } : {}),
    ...(values.workerMemoryLimit === undefined
      ? {}
      : { workerMemoryLimit: parseBytes(values.workerMemoryLimit, '--workerMemoryLimit') }),
    ...(values.maxFilesPerWorker === undefined
      ? {}
      : { maxFilesPerWorker: parseWhole(values.maxFilesPerWorker, '--maxFilesPerWorker') }),
    ...(values.fileTimeout === undefined
      ? {}
      : { fileTimeoutMs: parseWhole(values.fileTimeout, '--fileTimeout') }),
  }
  return {
    type: 'run',
    options,
    ...(values.forceExit === true ? { forceExit: true as const } : {}),
  }
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
  bail: { type: 'string' },
  forceExit: { type: 'boolean' },
  detectOpenHandles: { type: 'boolean' },
  workerMemoryLimit: { type: 'string' },
  maxFilesPerWorker: { type: 'string' },
  fileTimeout: { type: 'string' },
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
  /** The environment the reporters and `ci` read (the terminal, CI, an agent, colour). Default: the process's. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Aborted by the first SIGINT or SIGTERM (the bin's `handleSignals`); the run ends 130 or 143. */
  readonly signal?: AbortSignal
  /** Aborted by the second signal: every worker is killed at once. */
  readonly forceSignal?: AbortSignal
  /**
   * Called once when the command was given `--forceExit` and the run is over (after the reporters
   * have written): the process should end now, whatever is still open. The bin exits from it; this
   * module never calls `process.exit`.
   */
  readonly onForceExit?: () => void
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
  return runCommand(parsed, io)
}

/** `provino run`: the run, then the process's exit if `--forceExit` asked for it. */
async function runCommand(
  parsed: Extract<RunCommand, { readonly type: 'run' }>,
  io: CliIo,
): Promise<number> {
  const { exitCode } = await run({ ...parsed.options, ...ioOptions(io) })
  if (parsed.forceExit === true) {
    if (parsed.options.detectOpenHandles !== true) {
      ;(io.stderr ?? process.stderr).write(
        'Provino: force exiting. Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?\n',
      )
    }
    io.onForceExit?.()
  }
  return exitCode
}

function runBareJest(args: readonly string[], io: CliIo): Promise<number> {
  return runJestCommand(args, {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    cwd: io.cwd ?? process.cwd(),
    ...(io.env === undefined ? {} : { env: io.env }),
    ...(io.signal === undefined ? {} : { signal: io.signal }),
    ...(io.forceSignal === undefined ? {} : { forceSignal: io.forceSignal }),
    ...(io.onForceExit === undefined ? {} : { onForceExit: io.onForceExit }),
  })
}

async function helpExit(io: CliIo): Promise<number> {
  await (io.stdout ?? process.stdout).write(USAGE)
  return ExitCode.Pass
}

function ioOptions(
  io: CliIo,
): Pick<RunOptions, 'stdout' | 'stderr' | 'cwd' | 'env' | 'signal' | 'forceSignal'> {
  return {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    ...(io.cwd === undefined ? {} : { cwd: io.cwd }),
    ...(io.env === undefined ? {} : { env: io.env }),
    ...(io.signal === undefined ? {} : { signal: io.signal }),
    ...(io.forceSignal === undefined ? {} : { forceSignal: io.forceSignal }),
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
    return await runCommand(parsed, io)
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
