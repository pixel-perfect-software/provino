// T11.16: the Vitest 5.0.5 command line, `parseCLI` and the checks the `vitest` bin makes, rebuilt
// with no dependency (speed: B14c's precedent; cac's grammar is `internal/cac-parse.ts`):
//
//   createCLI().parse(['node', '/index.js', ...args], { run: false }) // cac.ts, every command's options
//   then runMatchedCommand's checks (the bin's `createCLI().parse()` makes them before an action)
//   then parseCLI's own steps: watch/dev set `watch`, run sets `run`, related moves the filters
//
// `parseVitestArgv` returns what `parseCLI` returns (`filter` and `options`, with cac's aliases and
// defaults: `-t x` gives both `t` and `testNamePattern`, `color: true` is `--no-color`'s default) and
// the command. Bad input throws a `VitestCliError` whose message is the error Vitest throws (a
// `CACError` or an option's `transform`), which the `vitest` bin leaves uncaught (exit 1).
// `parseVitestCli` adds Provino's diagnostics from `cli-table.ts`'s `support` column, and
// `vitestArgvToRunRequest` turns the argv into the neutral `RunRequest`. `cli.test.ts` holds all of
// it to the real `vitest/node`.
//
// Not rebuilt, refused by name: `--help`/`-h` and `--version`/`-v` (cac prints text), and a flag
// named like an `Object.prototype` member (`VITEST_CLI_UNSUPPORTED_FORM`).
import type { CliDialect, Diagnostic, FileFilter, FlagSpec, RunRequest } from '@provino/types'
import { VITEST_CLI_OPTIONS, VITEST_LIST_OPTIONS, type VitestCliOption } from './cli-table.ts'
import { patheNormalize } from './internal/cac-normalize.ts'
import {
  type CacBag,
  type CacCommand,
  CacError,
  type CacOption,
  cacCheck,
  cacCommand,
  cacOption,
  cacParse,
} from './internal/cac-parse.ts'

export {
  VITEST_CLI_OPTIONS,
  VITEST_LIST_OPTIONS,
  type VitestCliOption,
  type VitestCliSupport,
  type VitestCliValue,
} from './cli-table.ts'

/**
 * Why a Vitest command line was refused.
 * @public
 */
export type VitestCliErrorCode =
  | 'VITEST_CLI_INVALID'
  | 'VITEST_CLI_UNSUPPORTED'
  | 'VITEST_CLI_UNSUPPORTED_FORM'

/**
 * A Vitest command line Provino can't run. For `VITEST_CLI_INVALID`, `message` is the error Vitest
 * 5.0.5 throws and `upstreamName` its class (`CACError`, `Error`, `TypeError`, `SyntaxError`).
 * @public
 */
export class VitestCliError extends Error {
  readonly code: VitestCliErrorCode
  readonly upstreamName: string

  constructor(code: VitestCliErrorCode, message: string, upstreamName = 'Error') {
    super(message)
    this.name = 'VitestCliError'
    this.code = code
    this.upstreamName = upstreamName
  }
}

/**
 * Vitest's commands (`cac.ts` `createCLI`, in its order); `''` is the bare `vitest [...filters]`.
 * @public
 */
export type VitestCommandName =
  | 'run'
  | 'related'
  | 'watch'
  | 'dev'
  | 'bench'
  | 'init'
  | 'doctor'
  | 'list'
  | ''
  | 'complete'

/**
 * A parsed Vitest command line: `filters` and `options` are `parseCLI`'s `filter` and `options`.
 * @public
 */
export interface VitestArgv {
  readonly command: VitestCommandName
  readonly filters: readonly unknown[]
  readonly options: Readonly<Record<string, unknown>>
  /** The camel-cased keys the command line set, with mri's raw value, in order. */
  readonly given: readonly (readonly [string, unknown])[]
}

// --- Vitest's transforms (cli-config.ts, v5.0.5) ---------------------------------------------

const yesNo = (value: unknown): unknown => {
  if (value === 'true' || value === 'yes' || value === true) return true
  if (value === 'false' || value === 'no' || value === false) return false
  return value
}

const nestedBoolean = (value: unknown): unknown =>
  typeof value === 'boolean' ? { enabled: value } : value

const isObjectValue = (value: unknown): boolean => typeof value === 'object'

const inspect = (value: unknown): unknown => {
  if (value === 0 || value === 'true' || value === 'yes') return true
  if (value === 'false' || value === 'no') return false
  return value
}

/** Each option's own `transform`, by `VitestCliValue`, with its line in `cli-config.ts`. */
const TRANSFORMS: Readonly<Record<string, (value: unknown) => unknown>> = {
  // L114
  api: (value) => (typeof value === 'number' ? { port: value } : value),
  // L125
  silent: (value) => {
    if (value === 'true' || value === 'yes' || value === true) return true
    if (value === 'false' || value === 'no' || value === false) return false
    if (value === 'passed-only') return value
    throw new TypeError(
      `Unexpected value "--silent=${String(value)}". Use "--silent=true ${String(value)}" instead.`,
    )
  },
  // L63 transformNestedBoolean
  'nested-boolean': nestedBoolean,
  // L227, L309
  'yes-no': yesNo,
  // L56 watermarkTransform
  watermarks: (value) => (typeof value === 'string' ? value.split(',').map(Number) : value),
  // L354
  browser: (value) => {
    if (typeof value === 'boolean') return { enabled: value }
    if (value === 'true' || value === 'false') return { enabled: value === 'true' }
    if (value === 'yes' || value === 'no') return { enabled: value === 'yes' }
    if (typeof value === 'string') return { name: value }
    return value
  },
  // L409
  'browser-trace': (value) => ({ mode: value }),
  // L444
  locators: (value) => (typeof value !== 'object' || value == null ? {} : value),
  // L550, L563
  inspect,
  // L604
  'retry-condition': (value) => (typeof value === 'string' ? new RegExp(value, 'i') : value),
  // L796
  expect: (value) => {
    if (!isObjectValue(value)) {
      throw new TypeError(
        `Unexpected value for --expect: ${String(value)}. If you need to configure expect options, use --expect.{name}=<value> syntax`,
      )
    }
    return value
  },
  // L786
  'expect-poll': (value) => {
    if (!isObjectValue(value)) {
      throw new TypeError(
        `Unexpected value for --expect.poll: ${String(value)}. If you need to configure timeout, use --expect.poll.timeout=<timeout>`,
      )
    }
    return value
  },
  // L841
  'merge-reports': (value) => (!value || typeof value === 'boolean' ? '.vitest/blob' : value),
  // L881
  'import-durations': (value) => (typeof value === 'boolean' ? { print: value } : value),
  // L892
  'import-durations-print': (value) => value,
}

/** cac.ts `removeQuotes` (L211). */
function removeQuotes(value: unknown): unknown {
  if (typeof value !== 'string') return Array.isArray(value) ? value.map(removeQuotes) : value
  if (value[0] === '"' && value.endsWith('"')) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

/** @vitest/utils `toArray`. */
const toArray = (value: unknown): unknown[] => {
  const v = value ?? []
  return Array.isArray(v) ? v : [v]
}

/** cac.ts `addCommand`'s `transform` (L22-L38) for one row. */
function typeOf(row: VitestCliOption): (value: unknown) => unknown {
  const isArray = row.value === 'array' || row.array === true
  const own = row.value === undefined ? undefined : TRANSFORMS[row.value]
  return (input: unknown): unknown => {
    if (!isArray && Array.isArray(input)) {
      const received = input.map((s: unknown) => (typeof s === 'string' ? `"${s}"` : s)).join(', ')
      throw new Error(`Expected a single value for option "${row.flag}", received [${received}]`)
    }
    const value = removeQuotes(input)
    if (own !== undefined) return own(value)
    if (isArray) return toArray(value)
    if (row.value === 'normalize') return patheNormalize(String(value))
    return value
  }
}

const CAC_OWN = new Set(['version', 'help'])

const toCac = (row: VitestCliOption): CacOption =>
  cacOption(row.flag, CAC_OWN.has(row.path) ? undefined : typeOf(row))

const GLOBAL_OPTIONS: readonly CacOption[] = VITEST_CLI_OPTIONS.map(toCac)

/** `collectCliOptionsConfig`: every option, `changed` replaced in place, then `list`'s own. */
const LIST_ROWS: readonly VitestCliOption[] = (() => {
  const byPath = new Map(VITEST_LIST_OPTIONS.map((row) => [row.path, row]))
  const rows = VITEST_CLI_OPTIONS.filter((row) => !CAC_OWN.has(row.path)).map((row) => {
    const replaced = byPath.get(row.path)
    if (replaced !== undefined) byPath.delete(row.path)
    return replaced ?? row
  })
  return [...rows, ...byPath.values()]
})()

const COMMANDS: readonly CacCommand[] = [
  cacCommand('run [...filters]', []),
  cacCommand('related [...filters]', []),
  cacCommand('watch [...filters]', []),
  cacCommand('dev [...filters]', []),
  cacCommand('bench [...filters]', []),
  cacCommand('init <project>', []),
  cacCommand('doctor [...filters]', []),
  cacCommand('list [...filters]', LIST_ROWS.map(toCac)),
  cacCommand('[...filters]', []),
  cacCommand('complete [shell]', []),
]

const ALL_ROWS: readonly VitestCliOption[] = [...VITEST_CLI_OPTIONS, ...VITEST_LIST_OPTIONS]

/** Every name a row answers to (cac's `Option.names`), for the diagnostics. */
const ROW_BY_NAME: ReadonlyMap<string, VitestCliOption> = new Map(
  ALL_ROWS.flatMap((row) =>
    cacOption(row.flag).names.map((name): [string, VitestCliOption] => [name, row]),
  ),
)

const PROTO_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype))

function refuseForms(args: readonly string[]): void {
  for (const arg of args) {
    if (arg === '--') return
    if (!arg.startsWith('-')) continue
    const name = arg.replace(/^-+(no-)?/, '').split(/[=.]/)[0] ?? ''
    if (
      PROTO_NAMES.has(name) ||
      PROTO_NAMES.has(name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()))
    ) {
      throw new VitestCliError(
        'VITEST_CLI_UNSUPPORTED_FORM',
        `${arg} is not supported: it names an Object.prototype member`,
      )
    }
  }
}

/**
 * `parseCLI(['vitest', ...args])` from `vitest/node` 5.0.5, plus the checks the `vitest` bin makes
 * before it runs a command (an unknown option, a missing value, `init` without its argument).
 * Throws a `VitestCliError`.
 * @public
 */
export function parseVitestArgv(args: readonly string[]): VitestArgv {
  refuseForms(args)
  let parsed: ReturnType<typeof cacParse>
  try {
    parsed = cacParse(args, GLOBAL_OPTIONS, COMMANDS)
  } catch (error) {
    throw invalid(error)
  }
  const options: CacBag = { ...parsed.options }
  if (options.help === true) {
    throw new VitestCliError(
      'VITEST_CLI_UNSUPPORTED',
      '--help is not supported: run the real vitest for its help',
    )
  }
  if (options.version === true && parsed.commandName === undefined) {
    throw new VitestCliError(
      'VITEST_CLI_UNSUPPORTED',
      '--version is not supported: run the real vitest for its version',
    )
  }
  try {
    cacCheck(parsed, GLOBAL_OPTIONS)
  } catch (error) {
    throw invalid(error)
  }
  const command = (parsed.command?.name ?? '') as VitestCommandName
  let filters: readonly unknown[] = parsed.args
  // parseCLI (cac.ts L230-L243).
  if (command === 'watch' || command === 'dev') options.watch = true
  if (command === 'run' && !options.watch) options.run = true
  if (command === 'related') {
    options.related = filters
    options.passWithNoTests ??= true
    filters = []
  }
  return { command, filters, options, given: parsed.given }
}

function invalid(error: unknown): VitestCliError {
  if (error instanceof Error) {
    return new VitestCliError(
      'VITEST_CLI_INVALID',
      error.message,
      error instanceof CacError ? 'CACError' : error.name,
    )
  }
  return new VitestCliError('VITEST_CLI_INVALID', String(error))
}

const NOT_SUPPORTED = 'VITEST_CLI_UNSUPPORTED'
const NOT_APPLIED = 'VITEST_CLI_NOT_APPLIED'

/** Commands `provino vitest` refuses, with why (D175 for watch). */
const REFUSED_COMMANDS: Readonly<Partial<Record<VitestCommandName, string>>> = {
  watch: 'D175: provino vitest runs once, as vitest run; watch mode is a follow-up bundle',
  dev: 'D175: provino vitest runs once, as vitest run; watch mode is a follow-up bundle',
  related: 'a follow-up bundle (Vitest related)',
  bench: 'not planned: benchmarks',
  init: 'not planned: browser mode (D3)',
  doctor: 'a follow-up bundle (Vitest doctor)',
  list: 'parked (D183)',
  complete: 'not planned: shell completions',
}

/**
 * The row a given key answers to, and the name to report it by. A dotted key no row registers
 * (`--expect.soft`, `--sequence.foo`) has its nearest parent's row (cac takes it as that option's
 * property), so it is refused, warned or handed on with it, never dropped.
 */
function rowOf(key: string): { readonly row: VitestCliOption; readonly long: string } | undefined {
  const own = ROW_BY_NAME.get(key)
  if (own !== undefined) return { row: own, long: `--${own.path}` }
  const parts = key.split('.')
  for (let end = parts.length - 1; end > 0; end--) {
    const parent = ROW_BY_NAME.get(parts.slice(0, end).join('.'))
    if (parent !== undefined) return { row: parent, long: `--${key}` }
  }
  return undefined
}

const isOff = (value: unknown): boolean => value === false || value === 'false' || value === 'no'

/**
 * `parseVitestArgv`, plus Provino's diagnostics: an `error` for a refused command or a refused
 * option given with a value that turns it on, and a `warning` for an option read and not applied.
 * @public
 */
export function parseVitestCli(args: readonly string[]): {
  readonly argv: VitestArgv
  readonly diagnostics: Diagnostic[]
} {
  const argv = parseVitestArgv(args)
  const diagnostics: Diagnostic[] = []
  const refusedCommand = REFUSED_COMMANDS[argv.command]
  if (refusedCommand !== undefined) {
    diagnostics.push({
      level: 'error',
      code: NOT_SUPPORTED,
      key: argv.command,
      message: `vitest ${argv.command} is not supported (${refusedCommand})`,
    })
  }
  const seen = new Set<string>()
  for (const [key, value] of argv.given) {
    const found = rowOf(key)
    if (found === undefined || isOff(value)) continue
    const { row, long } = found
    if (seen.has(long)) continue
    seen.add(long)
    if (row.support === 'refuse') {
      diagnostics.push({
        level: 'error',
        code: NOT_SUPPORTED,
        key: long,
        message: `${long} is not supported (${row.owner})`,
      })
    } else if (row.support === 'warn') {
      diagnostics.push({
        level: 'warning',
        code: NOT_APPLIED,
        key: long,
        message: `${long} is read but not applied (${row.owner})`,
      })
    }
  }
  return { argv, diagnostics }
}

// --- the run request ---------------------------------------------------------------------------

/** `parseFilter` (`node/cli/filter.ts` L4-L25) over a filter `start` normalized (cac.ts L297). */
function fileFilterOf(raw: unknown): FileFilter {
  const filter = patheNormalize(String(raw))
  const colonIndex = filter.lastIndexOf(':')
  if (colonIndex === -1) return { kind: 'substring', value: filter }
  const filename = filter.substring(0, colonIndex)
  const lineNumber = filter.substring(colonIndex + 1)
  if (/^\d+$/.test(lineNumber))
    return { kind: 'pathLine', value: filename, line: Number.parseInt(lineNumber, 10) }
  if (/^\d+-\d+$/.test(lineNumber)) {
    // errors.ts L48-L56 (RangeLocationFilterProvidedError).
    throw new VitestCliError(
      'VITEST_CLI_INVALID',
      `Found "-" in location filter ${filter}.  Note that range location filters are not supported.  Consider specifying the exact line numbers of your tests.`,
    )
  }
  return { kind: 'substring', value: filter }
}

function maxWorkersOf(value: unknown): number | `${number}%` | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value)) return value as `${number}%`
  return undefined
}

/**
 * The `RunRequest` a parsed Vitest command line asks for: the filters as substring or `file:line`
 * filters, `-t`, `-u` (`true` and `all` update; `none` and `false` don't; `new` is the default and
 * says nothing), `--passWithNoTests`, `-c`, `--maxWorkers` when it is a count or a percentage, and
 * `--color`/`--no-color` when given. `list` is the `list-files` mode. Throws a `VitestCliError` for
 * a range location filter (`a.test.ts:1-2`).
 * @public
 */
export function vitestArgvToRunRequest(argv: VitestArgv): RunRequest {
  const { options } = argv
  const givenKeys = new Set(argv.given.map(([key]) => key))
  const namePattern = options.testNamePattern
  const update = options.update
  const configPath = options.config
  const maxWorkers = maxWorkersOf(options.maxWorkers)
  const list = argv.command === 'list'
  return {
    mode: list ? 'list-files' : 'run',
    json: list && options.json !== undefined && options.json !== false,
    fileFilters: argv.filters.map(fileFilterOf),
    ...(namePattern === undefined ? {} : { namePattern: String(namePattern) }),
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    inBand: false,
    ...(update === true || update === 'all'
      ? { update: true }
      : update === false || update === 'none'
        ? { update: false }
        : {}),
    ...(typeof options.passWithNoTests === 'boolean'
      ? { passWithNoTests: options.passWithNoTests }
      : {}),
    ...(configPath === undefined ? {} : { configPath: String(configPath) }),
    ...(givenKeys.has('color') && typeof options.color === 'boolean'
      ? { colour: options.color }
      : {}),
  }
}

/**
 * The options a parsed command line sets that are config keys (`support: 'config'` in the table:
 * `--globals`, `--pool`, `--maxWorkers`, `--environment`, `--bail`, `--sequence.*`, …), shaped
 * like `config.test`, for the reader's `test` option: Vitest merges them over the file's `test`
 * (`createVitest`'s `cliOptions`). A dotted path lands nested (`sequence.shuffle`).
 * @public
 */
export function vitestArgvToTestConfig(argv: VitestArgv): Record<string, unknown> {
  const test: Record<string, unknown> = {}
  for (const row of VITEST_CLI_OPTIONS) {
    if (row.support !== 'config') continue
    const parts = row.path.split('.')
    let source: unknown = argv.options
    for (const part of parts) {
      source =
        typeof source === 'object' && source !== null
          ? (source as Record<string, unknown>)[part]
          : undefined
    }
    if (source === undefined) continue
    let target = test
    for (const part of parts.slice(0, -1)) {
      const next = target[part]
      if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
        target = next as Record<string, unknown>
      } else {
        const created: Record<string, unknown> = {}
        target[part] = created
        target = created
      }
    }
    target[parts[parts.length - 1] as string] = source
  }
  // cac.ts L283-L286: `--exclude` is `cliExclude`, which the reader adds to the excludes.
  if (test.exclude !== undefined) {
    test.cliExclude = test.exclude
    delete test.exclude
  }
  return test
}

/**
 * The Vitest command line: `parse` is `parseVitestCli`, `toRunRequest` is `vitestArgvToRunRequest`.
 * @public
 */
export const vitestCli: CliDialect<VitestArgv> = {
  parse: parseVitestCli,
  toRunRequest: vitestArgvToRunRequest,
}

function flagSpec(row: VitestCliOption): FlagSpec {
  const parts =
    row.flag.split(' ')[0] === undefined ? [] : row.flag.replace(/ [<[].*$/, '').split(', ')
  const long = parts.find((part) => part.startsWith('--')) ?? `--${row.path}`
  const short = parts.find((part) => !part.startsWith('--'))
  return {
    name: long,
    ...(short === undefined ? {} : { short }),
    takesValue: /[<[]/.test(row.flag),
    description: row.description,
  }
}

/**
 * The flags the Vitest command line accepts, in cac's order (`list`'s own last).
 * @public
 */
export const vitestFlags: readonly FlagSpec[] = [
  ...VITEST_CLI_OPTIONS,
  ...VITEST_LIST_OPTIONS.filter((row) => row.path !== 'changed'),
].map(flagSpec)
