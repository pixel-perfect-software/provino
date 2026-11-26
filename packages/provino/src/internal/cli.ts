import { dirname, resolve } from 'node:path'
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { ExitCode } from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { PoolKind } from '@provino/types'
import { run } from '../run.ts'
import type { ReporterChoice, RunOptions } from '../types.ts'
import { reportAddOnFailure, setAddOnRoot } from './add-on.ts'
import { detectProject } from './detect.ts'
import type { NativeWatchIo, WatchMode } from './native-watch.ts'
import { quickAnswer } from './quick.ts'
import {
  BUILT_IN_REPORTERS,
  type BuiltInReporterName,
  DOCUMENT_REPORTERS,
  isBuiltInReporter,
  isDocumentReporter,
} from './reporter-names.ts'
import { USAGE } from './usage.ts'
import { UsageError } from './usage-error.ts'
import { hasViews, viewsOf } from './views.ts'

/** What the process exits with for an error that is a bug in Provino. */
const INTERNAL_ERROR_EXIT = 1

const POOL_KINDS: readonly PoolKind[] = ['forks', 'threads', 'inline']

/**
 * What `provino run` is asked for: `run()`'s options, with the config file only when the command
 * line named one (else it is found by walking up from the working directory, D196).
 * @internal
 */
export type ParsedRunOptions = Omit<RunOptions, 'config'> & {
  readonly config?: string
  /** `--watch` (the files a change reaches) or `--watchAll` (every file): see `native-watch.ts`. */
  readonly watch?: WatchMode
}

/**
 * What a command line asks for.
 * @internal
 */
export type RunCommand =
  | { readonly type: 'help' }
  | { readonly type: 'run'; readonly options: ParsedRunOptions; readonly forceExit?: true }
  | { readonly type: 'jest'; readonly args: readonly string[] }
  | { readonly type: 'vitest'; readonly args: readonly string[] }
  | { readonly type: 'bare'; readonly args: readonly string[] }

function isPoolKind(value: string): value is PoolKind {
  return POOL_KINDS.some((kind) => kind === value)
}

/**
 * `--bail` with no count is `--bail=1`, and `--bail 2` is `--bail=2` (a test path pattern of
 * only digits needs `--bail=1 2` or `--`): `parseArgs` has no option with an optional value.
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

/**
 * `--shard=2/5`: shard 2 of 5. Both numbers are digits only, the count at least 1 and the index from
 * 1 to the count (Jest's own rule for its flag).
 */
function parseShard(text: string): { readonly index: number; readonly count: number } {
  const match = /^(\d+)\/(\d+)$/.exec(text)
  const index = match === null ? Number.NaN : Number(match[1])
  const count = match === null ? Number.NaN : Number(match[2])
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    index < 1 ||
    index > count
  ) {
    throw new UsageError(
      `--shard must be <index>/<count>, both whole numbers, from 1 to the count (such as 2/5; got "${text}")`,
    )
  }
  return { index, count }
}

/** One `--reporter` name as the choice it stands for: the reporter that owns `--outputFile` takes it, any other stands for itself. */
function choiceFor(
  name: BuiltInReporterName,
  owner: BuiltInReporterName | undefined,
  outputFile: string | undefined,
): ReporterChoice {
  return name === owner && outputFile !== undefined && isDocumentReporter(name)
    ? [name, { outputFile }]
    : name
}

/**
 * `--reporter` names, with `--outputFile` going to the one reporter that writes a document:
 * `json`, `normalized-json` or `junit`, and `html` only when none of those is named (D146: beside
 * one of them `--outputFile` is theirs, and `html` writes `provino-report.html` in the run's root).
 * Every name is checked first, so a misspelt one is named as such whatever else is wrong.
 */
function parseReporters(
  names: readonly string[],
  outputFile: string | undefined,
): readonly ReporterChoice[] {
  const known: BuiltInReporterName[] = []
  for (const [index, name] of names.entries()) {
    if (!isBuiltInReporter(name)) {
      throw new UsageError(
        `unknown reporter "${name}" (use ${BUILT_IN_REPORTERS.join(', ')}) for --reporter`,
      )
    }
    if (names.indexOf(name) !== index) {
      throw new UsageError(`--reporter ${name} is given more than once`)
    }
    known.push(name)
  }
  // The document reporters that take `--outputFile` before `html` does.
  const writers = known.filter(isDocumentReporter)
  const toStdout = writers.filter((name) => DOCUMENT_REPORTERS[name] === null)
  // `--outputFile` is the first document reporter's that would write to stdout, else the first one's.
  const owner = toStdout[0] ?? writers[0]
  if (outputFile !== undefined) {
    if (owner === undefined) {
      throw new UsageError('--outputFile needs --reporter json, normalized-json, junit or html')
    }
    if (toStdout.length > 1) {
      throw new UsageError(
        `--outputFile is one path, and ${toStdout.join(' and ')} each write a document: name one of them, or give each its outputFile in a script`,
      )
    }
  }
  return known.map((name) => choiceFor(name, owner, outputFile))
}

/**
 * Parses the arguments after `run`. A flag it doesn't know or a missing or bad value is a
 * `UsageError`; with no `--config` the file is found later (`runCommand`). Every positional
 * argument is a test path pattern (Jest's `testPathPatterns`: a case-insensitive regular expression
 * over the file's path); `--` ends the flags.
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
  const { values, positionals } = parsed
  if (values.help === true) return { type: 'help' }
  const watching = values.watch === true || values.watchAll === true
  if (values.watch === true && values.watchAll === true) {
    throw new UsageError('--watch and --watchAll are one or the other')
  }
  if (watching) {
    // What a watch session can't honour, each named: one list, before anything starts.
    const refused = [
      ...(values.coverage === true ? ['--coverage'] : []),
      ...(values.shard === undefined ? [] : ['--shard']),
      ...(values.detectOpenHandles === true ? ['--detectOpenHandles'] : []),
      ...(values.timings === undefined ? [] : ['--timings']),
      ...(values['update-timings'] === true ? ['--update-timings'] : []),
      ...(values.forceExit === true ? ['--forceExit'] : []),
    ]
    if (refused.length > 0) {
      throw new UsageError(
        `${refused.join(', ')} in watch mode ${refused.length === 1 ? 'is' : 'are'} not supported yet`,
      )
    }
  }
  if (values.pool !== undefined && !isPoolKind(values.pool)) {
    throw new UsageError(`--pool must be one of ${POOL_KINDS.join(', ')} (got "${values.pool}")`)
  }
  const names = values.reporter ?? []
  const reporters = parseReporters(names, values.outputFile)
  const views = viewsOf(values.tree, values.map)
  const options: ParsedRunOptions = {
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.maxWorkers === undefined
      ? {}
      : { maxWorkers: parseWhole(values.maxWorkers, '--maxWorkers') }),
    ...(values.pool === undefined ? {} : { pool: values.pool }),
    ...(names.length === 0 ? {} : { reporters }),
    ...(hasViews(views) ? { views } : {}),
    ...(positionals.length === 0 ? {} : { testPathPatterns: positionals }),
    ...(values.ci === true ? { ci: true } : {}),
    ...(values.updateSnapshot === true ? { updateSnapshot: true } : {}),
    ...(values.coverage === true ? { coverage: true } : {}),
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
    ...(values.shard === undefined ? {} : { shard: parseShard(values.shard) }),
    ...(values.timings === undefined ? {} : { timingsFile: values.timings }),
    ...(values['update-timings'] === true ? { updateTimings: true } : {}),
    ...(values['no-emoji'] === true ? { emoji: false as const } : {}),
    ...(values.watchAll === true
      ? { watch: 'all' as const }
      : values.watch === true
        ? { watch: 'changed' as const }
        : {}),
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
  shard: { type: 'string' },
  timings: { type: 'string' },
  'update-timings': { type: 'boolean' },
  'no-emoji': { type: 'boolean' },
  tree: { type: 'boolean' },
  map: { type: 'boolean' },
  watch: { type: 'boolean' },
  watchAll: { type: 'boolean' },
  coverage: { type: 'boolean' },
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
  return parseArgs({ args: [...args], allowPositionals: true, strict: true, options: OPTIONS })
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
  /** What `--watch` reads keys, changes and time from, in place of the process's (a test's). */
  readonly watchIo?: NativeWatchIo
}

/** What `command` and its `args` ask for. */
function parseCommand(command: string | undefined, args: readonly string[]): RunCommand {
  if (command === undefined) return { type: 'bare', args: [] }
  if (command === 'run') return parseRunArgs(args)
  if (command === 'jest') return { type: 'jest', args }
  if (command === 'vitest') return { type: 'vitest', args }
  // Anything else is the bare form, as `provino jest <pattern>` is: a flag (`provino --dialect jest
  // -t foo`) or a test path pattern (`provino math`, `provino src/a.test.ts`).
  return { type: 'bare', args: [command, ...args] }
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
  // The add-ons resolve from the project's directory, the one whose config decided (D187).
  if (found.kind !== 'provino') setAddOnRoot(found.directory)
  if (found.kind === 'vitest') return runBareVitest(rest, io, found.directory)
  if (found.kind === 'jest') return runBareJest(rest, io)
  const parsed = parseRunArgs(['--config', found.config, ...rest])
  if (parsed.type === 'help') return helpExit(io)
  return runCommand(parsed, io)
}

/**
 * The directory of a `-c`/`--config` file on a `provino jest` or `provino vitest` command line,
 * as the add-ons' root (D187); with none, the root `main` or the detection set stays.
 */
function setAddOnRootFromConfigFlag(args: readonly string[], cwd: string): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg === '--') return
    const inline = /^(?:--config|-c)=(.+)$/.exec(arg)?.[1]
    const value = inline ?? (arg === '--config' || arg === '-c' ? args[index + 1] : undefined)
    if (value !== undefined && value !== '' && !value.startsWith('{')) {
      setAddOnRoot(dirname(resolve(cwd, value)))
      return
    }
  }
}

/**
 * The config `provino run` takes with no `--config`: the nearest directory with any config decides
 * (D200), so a Jest or Vitest config nearer than a `provino.config.*` is an error that says so,
 * not a reason to run the farther one.
 */
async function nearestProvinoConfig(cwd: string): Promise<string> {
  const found = await detectProject(cwd)
  if (found.kind === 'provino') return found.config
  throw new UsageError(
    `the nearest config is a ${found.kind === 'jest' ? 'Jest' : 'Vitest'} config in ${found.directory}, not a provino.config.*: run provino there, or name the file with --config <file>`,
  )
}

/** `provino run`: the run, then the process's exit if `--forceExit` asked for it. */
async function runCommand(
  parsed: Extract<RunCommand, { readonly type: 'run' }>,
  io: CliIo,
): Promise<number> {
  const cwd = io.cwd ?? process.cwd()
  const config = parsed.options.config ?? (await nearestProvinoConfig(cwd))
  // A config's `provino/jest` resolves from the config's directory (D187).
  setAddOnRoot(dirname(resolve(cwd, config)))
  const { watch, ...options } = parsed.options
  if (watch !== undefined) {
    // Imported only here, so a run without watch loads none of it.
    const { runNativeWatch } = await import('./native-watch.ts')
    return runNativeWatch({ ...options, config, ...ioOptions(io) }, watch, io.watchIo)
  }
  const { exitCode } = await run({ ...options, config, ...ioOptions(io) })
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

/**
 * `provino jest`, imported only here, so `provino run` and a native project load none of the Jest
 * dialect's coordinator code (D115, `speed`).
 */
async function runBareJest(args: readonly string[], io: CliIo): Promise<number> {
  setAddOnRootFromConfigFlag(args, io.cwd ?? process.cwd())
  // An add-on that isn't there fails this import with Node's error, which `main` reports.
  const { runJestCommand } = await import('./jest-command.ts')
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

/**
 * `provino vitest`, imported only here, so a Jest or `provino run` command loads none of the Vitest
 * dialect's coordinator code (D115, `speed`).
 */
async function runBareVitest(
  args: readonly string[],
  io: CliIo,
  directory?: string,
): Promise<number> {
  setAddOnRootFromConfigFlag(args, directory ?? io.cwd ?? process.cwd())
  const { runVitestCommand } = await import('./vitest-command.ts')
  return runVitestCommand(args, {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    cwd: directory ?? io.cwd ?? process.cwd(),
    ...(io.env === undefined ? {} : { env: io.env }),
    ...(io.signal === undefined ? {} : { signal: io.signal }),
    ...(io.forceSignal === undefined ? {} : { forceSignal: io.forceSignal }),
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
    // The add-ons (D187) resolve from the project, not from provino's own install folder.
    setAddOnRoot(io.cwd ?? process.cwd())
    const [command, ...args] = argv
    const parsed = parseCommand(command, args)
    if (parsed.type === 'help') return await helpExit(io)
    if (parsed.type === 'bare') return await runBare(parsed.args, io)
    if (parsed.type === 'jest') return await runBareJest(parsed.args, io)
    if (parsed.type === 'vitest') return await runBareVitest(parsed.args, io)
    return await runCommand(parsed, io)
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`Provino: ${error.message}\n\n${USAGE}`)
      return ExitCode.UsageError
    }
    // A dialect's add-on that isn't installed (D187): one line with the install command, no stack.
    const addOn = reportAddOnFailure(error, stderr)
    if (addOn !== undefined) return addOn
    stderr.write(
      `Provino: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    return INTERNAL_ERROR_EXIT
  }
}
