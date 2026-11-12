// T11.7: the Jest 30.5 command line, `jest-cli` 30.5.2's `buildArgv` rebuilt (no yargs,
// yargs-parser, jest-validate, leven or camelcase dependency):
//
//   yargs(args).usage().version().alias('help', 'h').options(table).check(check).argv
//   then jest-validate's validateCLIOptions, then the keys containing '-' dropped
//
// `parseJestArgv` returns what `buildArgv` returns (minus `$0`), with the same keys: yargs sets
// both the camelCase key and the alias (`-b` gives `{ b: true, bail: true }`), `--no-cache` gives
// `{ cache: false }`, positionals go to `_`, and so on; the config reader's `setFromArgv` reads it
// as it is. `internal/yargs-parse.ts` is the yargs-parser port. Bad input throws a `JestCliError`
// whose message is Jest's own text (yargs prints its message and `process.exit(1)`s; jest-validate
// throws), and the caller maps it to its usage exit code. `parseJestCli` adds Provino's own
// diagnostics (the flags it reads but doesn't apply yet, and the ones it has no backend for), and
// `jestArgvToRunRequest` turns the argv into the neutral `RunRequest`. `cli.test.ts` compares all of
// it with real `jest-cli`.
//
// What is not rebuilt, and refused by name rather than parsed differently:
// - `--help`, `-h`, a trailing `help` positional and `--version`: yargs prints text and exits 0.
//   Provino leaves them to the real `jest` (`JEST_CLI_UNSUPPORTED`).
// - yargs' completion request (`--get-yargs-completions`), and a flag named like an
//   `Object.prototype` property (`--constructor`: real Jest crashes on it): `JEST_CLI_UNSUPPORTED_FORM`.
import type { CliDialect, Diagnostic, FileFilter, FlagSpec, RunRequest } from '@provino/types'
import { JEST_CLI_OPTIONS, type JestCliOption } from './cli-table.ts'
import { JestCliError } from './errors.ts'
import { isJSONString, JEST_CONFIG_EXT_ORDER } from './find.ts'
import { camelcase } from './internal/camelcase.ts'
import { type Bag, looksLikeNumber, type YargsOption, yargsParse } from './internal/yargs-parse.ts'
import { didYouMean, formatValue, VALIDATE_BULLET, validationText } from './text.ts'
import type { JestArgv } from './types.ts'
import { DEPRECATED_CONFIG } from './validate.ts'

export { JEST_CLI_OPTIONS, type JestCliOption, type JestCliSupport } from './cli-table.ts'
export { JestCliError, type JestCliErrorCode } from './errors.ts'

const YARGS_OPTIONS: readonly YargsOption[] = Object.entries(JEST_CLI_OPTIONS).map(
  ([key, option]) => ({
    key,
    alias: option.alias,
    type: option.type,
    string: option.string,
    requiresArg: option.requiresArg,
  }),
)

/** The options with `choices`, which yargs checks after the parse (`validation.js` `limitedChoices`). */
const CHOICE_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(JEST_CLI_OPTIONS).flatMap(([key, option]): [string, readonly string[]][] =>
    option.choices === undefined ? [] : [[key, option.choices]],
  ),
)

// --- yargs' own validations --------------------------------------------------------------------

/** yargs `usage.js` `stringifiedValues`. */
function stringifiedValues(values: unknown): string {
  const list = Array.isArray(values) ? values : [values]
  return list.map((value: unknown) => JSON.stringify(value)).join(', ')
}

/** yargs `validation.js` `limitedChoices` (L141-L165): a value outside an option's choices. */
function checkChoices(argv: Bag): void {
  const invalid = new Map<string, unknown[]>()
  for (const key of Object.keys(argv)) {
    const choices = CHOICE_OPTIONS.get(key)
    if (choices === undefined) continue
    const value = argv[key]
    for (const given of Array.isArray(value) ? value : [value]) {
      if (!choices.includes(given as string) && given !== undefined) {
        invalid.set(key, [...(invalid.get(key) ?? []), given])
      }
    }
  }
  if (invalid.size === 0) return
  let message = 'Invalid values:'
  for (const [key, values] of invalid) {
    message += `\n  Argument: ${key}, Given: ${stringifiedValues(values)}, Choices: ${stringifiedValues(
      CHOICE_OPTIONS.get(key),
    )}`
  }
  throw new JestCliError('JEST_CLI_INVALID', message)
}

/**
 * yargs `validation.js` `conflicting` (L250-L262) looks each argv key up in a plain `{}`, so a flag
 * named like an `Object.prototype` property (`--constructor`, `--toString`, `--valueOf`, ...) makes
 * real Jest crash with `l[t].forEach is not a function` (after the choices check, before `check`).
 * Refused by name instead.
 */
function checkPrototypeKeys(argv: Bag): void {
  for (const key of Object.keys(argv)) {
    if (key in Object.prototype) {
      throw new JestCliError(
        'JEST_CLI_UNSUPPORTED_FORM',
        `--${key}: Jest itself fails on a flag named like an Object property ("l[t].forEach is not a function"), so it is not supported.`,
      )
    }
  }
}

/**
 * yargs' `kPostProcess` (`yargs-factory.js` L1242): what follows `--` is appended to `_`, then the
 * positionals that look like safe integers become numbers.
 */
function postProcess(argv: Bag): void {
  const positionals = argv._ as unknown[]
  const afterDashes = argv['--']
  if (Array.isArray(afterDashes)) {
    positionals.push(...(afterDashes as unknown[]))
    delete argv['--']
  }
  for (let i = 0; i < positionals.length; i++) {
    const arg = positionals[i]
    if (looksLikeNumber(arg) && Number.isSafeInteger(Math.floor(Number.parseFloat(`${arg}`)))) {
      positionals[i] = Number(arg)
    }
  }
}

const CONFIG_EXTENSION = new RegExp(
  `\\.(${JEST_CONFIG_EXT_ORDER.map((ext) => ext.slice(1)).join('|')})$`,
  'i',
)

function lengthOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, 'length') : undefined
}

/** `jest-cli` `src/args.ts` L12-L96 (`check`): the messages are copied exactly. */
function check(argv: Bag): void {
  const fail = (message: string): never => {
    throw new JestCliError('JEST_CLI_INVALID', message)
  }
  const has = (key: string): boolean => Object.hasOwn(argv, key)
  if (argv.runInBand && has('maxWorkers')) {
    fail('Both --runInBand and --maxWorkers were specified, only one is allowed.')
  }
  for (const key of ['onlyChanged', 'lastCommit', 'changedFilesWithAncestor', 'changedSince']) {
    if (argv[key] && argv.watchAll) {
      fail(
        `Both --${key} and --watchAll were specified, but cannot be used ` +
          'together. Try the --watch option which reruns only tests ' +
          'related to changed files.',
      )
    }
  }
  if (argv.onlyFailures && argv.watchAll) {
    fail('Both --onlyFailures and --watchAll were specified, only one is allowed.')
  }
  if (argv.findRelatedTests && (argv._ as unknown[]).length === 0) {
    fail(
      'The --findRelatedTests option requires file paths to be specified.\n' +
        'Example usage: jest --findRelatedTests ./src/source.js ' +
        './src/index.js.',
    )
  }
  if (has('maxWorkers') && argv.maxWorkers === undefined) {
    fail(
      'The --maxWorkers (-w) option requires a number or string to be specified.\n' +
        'Example usage: jest --maxWorkers 2\n' +
        'Example usage: jest --maxWorkers 50%\n' +
        'Or did you mean --watch?',
    )
  }
  if (argv.selectProjects && lengthOf(argv.selectProjects) === 0) {
    fail(
      'The --selectProjects option requires the name of at least one project to be specified.\n' +
        'Example usage: jest --selectProjects my-first-project my-second-project',
    )
  }
  if (argv.ignoreProjects && lengthOf(argv.ignoreProjects) === 0) {
    fail(
      'The --ignoreProjects option requires the name of at least one project to be specified.\n' +
        'Example usage: jest --ignoreProjects my-first-project my-second-project',
    )
  }
  if (
    argv.config &&
    !(typeof argv.config === 'string' && isJSONString(argv.config)) &&
    !CONFIG_EXTENSION.test(String(argv.config))
  ) {
    fail(
      `The --config option requires a JSON string literal, or a file path with one of these extensions: ${JEST_CONFIG_EXT_ORDER.join(
        ', ',
      )}.\nExample usage: jest --config ./jest.config.js`,
    )
  }
}

// --- jest-validate -----------------------------------------------------------------------------

/** jest-validate `validateCLIOptions.ts` L21-L24: the comment of a deprecation error. */
const CLI_DOCUMENTATION_NOTE = `  CLI Options Documentation:
  https://jestjs.io/docs/cli
`

/** `validateCLIOptions`'s `yargsSpecialOptions` and the table's keys and aliases, in that order. */
const ALLOWED_OPTIONS: ReadonlySet<string> = new Set([
  '$0',
  '_',
  'help',
  'h',
  // `{ ...args.options, deprecationEntries }` is what jest-cli passes: the extra key is allowed too
  ...[...Object.keys(JEST_CLI_OPTIONS), 'deprecationEntries'].flatMap((option) => [
    option,
    JEST_CLI_OPTIONS[option]?.alias ?? option,
  ]),
])

/** `validateCLIOptions.ts` L28-L60 (`createCLIValidationError`). */
function unrecognizedError(unrecognized: readonly string[]): JestCliError {
  let title = `${VALIDATE_BULLET} Unrecognized CLI Parameter`
  let message: string
  const comment = CLI_DOCUMENTATION_NOTE
  const [only] = unrecognized
  if (unrecognized.length === 1 && only !== undefined) {
    const suggestion = only.length > 1 ? didYouMean(only, [...ALLOWED_OPTIONS]) : ''
    message = `  Unrecognized option ${formatValue(only)}.${suggestion ? ` ${suggestion}` : ''}`
  } else {
    title += 's'
    message = `  Following options were not recognized:\n  ${formatValue(unrecognized)}`
  }
  return new JestCliError('JEST_CLI_UNRECOGNIZED', validationText(title, message, comment))
}

/** `validateCLIOptions.ts` L89-L128, for the keys `buildArgv` has after yargs. */
function validateCLIOptions(argv: Bag, rawArgv: readonly string[]): void {
  // every deprecated key is fatal here: none of them is a CLI option (L111, `!allowedOptions.has`)
  for (const key of Object.keys(argv)) {
    const deprecation = Object.hasOwn(DEPRECATED_CONFIG, key) ? DEPRECATED_CONFIG[key] : undefined
    if (deprecation !== undefined && argv[key] != null && !ALLOWED_OPTIONS.has(key)) {
      throw new JestCliError(
        'JEST_CLI_DEPRECATED',
        validationText(key, deprecation(), CLI_DOCUMENTATION_NOTE),
      )
    }
  }
  const unrecognized = Object.keys(argv).filter(
    (arg) =>
      !ALLOWED_OPTIONS.has(camelcase(arg)) &&
      !ALLOWED_OPTIONS.has(arg) &&
      (rawArgv.length === 0 || rawArgv.includes(arg)),
  )
  if (unrecognized.length > 0) throw unrecognizedError(unrecognized)
}

// --- the parser --------------------------------------------------------------------------------

/**
 * Parses Jest's command line (the arguments after `jest`), exactly as `jest-cli` 30.5.2's
 * `buildArgv` does, without `$0`. Throws a `JestCliError` where Jest prints an error and exits.
 * @public
 */
export function parseJestArgv(args: readonly string[]): JestArgv {
  const { argv, error } = yargsParse(args, YARGS_OPTIONS)
  // yargs: `--get-yargs-completions` answers a shell completion request and exits.
  if ('get-yargs-completions' in argv) {
    throw new JestCliError(
      'JEST_CLI_UNSUPPORTED_FORM',
      'The yargs completion request --get-yargs-completions is not supported.',
    )
  }
  // yargs-factory.js L1371: a trailing `help` positional is the help command.
  const positionals = argv._ as unknown[]
  let help = Boolean(argv.help)
  if (String(positionals[positionals.length - 1]) === 'help') {
    positionals.pop()
    help = true
  }
  if (help) {
    throw new JestCliError(
      'JEST_CLI_UNSUPPORTED',
      '--help (-h, or a trailing "help") is not supported; use the real jest for --help.',
    )
  }
  if (argv.version) {
    throw new JestCliError(
      'JEST_CLI_UNSUPPORTED',
      '--version is not supported; use the real jest for --version.',
    )
  }
  if (error !== null) throw new JestCliError('JEST_CLI_INVALID', error.message)
  checkChoices(argv)
  checkPrototypeKeys(argv)
  postProcess(argv)
  check(argv)
  validateCLIOptions(
    argv,
    args.map((arg) => arg.replace(/^--?/, '')),
  )
  // strip the dashed keys (`--max-workers` is also `maxWorkers`)
  const result: Bag = { _: argv._ }
  for (const key of Object.keys(argv)) {
    if (!key.includes('-') && key !== '_') result[key] = argv[key]
  }
  return result as JestArgv
}

const NOT_APPLIED = 'JEST_CLI_NOT_APPLIED'
const NOT_SUPPORTED = 'JEST_CLI_UNSUPPORTED'

/** A flag counts as given when it is present and not switched off (`--no-x`, `=false`). */
function isGiven(value: unknown): boolean {
  return value !== undefined && value !== false
}

/**
 * `parseJestArgv`, plus Provino's diagnostics: a `warning` for each flag it reads but doesn't apply
 * yet, and an `error` for each flag it has no backend for (named with the task that builds it).
 * The diagnostics come in the table's order.
 * @public
 */
export function parseJestCli(args: readonly string[]): {
  readonly argv: JestArgv
  readonly diagnostics: Diagnostic[]
} {
  const argv = parseJestArgv(args)
  const diagnostics: Diagnostic[] = []
  // `--json` and `--outputFile` write a run's results (T11.8); with `--listTests` they shape its list
  const listing = isGiven(argv.listTests)
  for (const [name, option] of Object.entries(JEST_CLI_OPTIONS)) {
    if (!isGiven(argv[name])) continue
    if (option.support === 'warn') {
      diagnostics.push({
        level: 'warning',
        code: NOT_APPLIED,
        key: `--${name}`,
        message: `--${name} is read but not applied yet (${option.owner})`,
      })
    } else if (option.support === 'refuse') {
      if (listing && (name === 'json' || name === 'outputFile')) continue
      diagnostics.push({
        level: 'error',
        code: NOT_SUPPORTED,
        key: `--${name}`,
        message: `--${name} is not supported yet (${option.owner})`,
      })
    }
  }
  return { argv, diagnostics }
}

// --- the run request ---------------------------------------------------------------------------

function strings(value: unknown): string[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).map(String)
}

/** A flag given twice is an array in yargs; the last one wins. */
function last(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value
}

function maxWorkersOf(value: unknown): number | `${number}%` | undefined {
  const given = last(value)
  if (given === undefined) return undefined
  const text = String(given)
  if (/^\d+$/.test(text)) return Number(text)
  if (/^\d+(\.\d+)?%$/.test(text)) return text as `${number}%`
  throw new JestCliError(
    'JEST_CLI_INVALID',
    `The --maxWorkers (-w) option takes a number of workers or a percentage of the cores, not "${text}".\n` +
      'Example usage: jest --maxWorkers 2\n' +
      'Example usage: jest --maxWorkers 50%',
  )
}

/**
 * The `RunRequest` a parsed Jest command line asks for. Positionals and `--testPathPatterns` are
 * regex file filters (positionals are exact paths with `--runTestsByPath`). When several of
 * `--showConfig`, `--clearCache` and `--listTests` are given, the mode is the one Jest acts on
 * first (`jest-core` `cli/index.ts` L62 and L67, then `runJest.ts` L310). Throws a `JestCliError`
 * for a `--maxWorkers` that is neither a count nor a percentage.
 * @public
 */
export function jestArgvToRunRequest(argv: JestArgv): RunRequest {
  const byPath = argv.runTestsByPath === true
  const fileFilters: FileFilter[] = [
    ...(argv._ ?? []).map(
      (value): FileFilter => ({
        kind: byPath ? 'path' : 'regex',
        value: String(value),
      }),
    ),
    ...strings(argv.testPathPatterns).map((value): FileFilter => ({ kind: 'regex', value })),
  ]
  let mode: RunRequest['mode'] = 'run'
  if (isGiven(argv.showConfig)) mode = 'show-config'
  else if (isGiven(argv.clearCache)) mode = 'clear-cache'
  else if (isGiven(argv.listTests)) mode = 'list-files'
  const namePattern = last(argv.testNamePattern)
  const maxWorkers = maxWorkersOf(argv.maxWorkers)
  const configPath = last(argv.config)
  const flag = (value: unknown): value is boolean => typeof value === 'boolean'
  return {
    mode,
    json: mode === 'list-files' && isGiven(argv.json),
    fileFilters,
    ...(namePattern === undefined ? {} : { namePattern: String(namePattern) }),
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    inBand: argv.runInBand === true,
    ...(flag(argv.workerThreads) ? { workerThreads: argv.workerThreads } : {}),
    ...(flag(argv.ci) ? { ci: argv.ci } : {}),
    ...(flag(argv.updateSnapshot) ? { update: argv.updateSnapshot } : {}),
    ...(flag(argv.passWithNoTests) ? { passWithNoTests: argv.passWithNoTests } : {}),
    ...(flag(argv.cache) ? { cache: argv.cache } : {}),
    ...(configPath === undefined ? {} : { configPath: String(configPath) }),
  }
}

/**
 * The Jest command line: `parse` is `parseJestCli`, `toRunRequest` is `jestArgvToRunRequest`.
 * @public
 */
export const jestCli: CliDialect<JestArgv> = {
  parse: parseJestCli,
  toRunRequest: jestArgvToRunRequest,
}

/** One `FlagSpec` per option: `name` and `short` with their dashes, `description` Jest's own. */
function flagSpec([name, option]: readonly [string, JestCliOption]): FlagSpec {
  return {
    name: `--${name}`,
    ...(option.alias === undefined
      ? {}
      : { short: option.alias.length === 1 ? `-${option.alias}` : `--${option.alias}` }),
    takesValue: option.type !== 'boolean',
    description: option.description,
  }
}

/**
 * The flags the Jest command line accepts, in `jest-cli`'s table order.
 * @public
 */
export const jestFlags: readonly FlagSpec[] = Object.entries(JEST_CLI_OPTIONS).map(flagSpec)
