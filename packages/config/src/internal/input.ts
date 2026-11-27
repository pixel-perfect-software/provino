import type {
  BaseConfig,
  ConfigCoverage,
  ConfigResolve,
  ConfigTimeouts,
  CoverageReporterName,
  Dialect,
  IsolationTier,
  JsonValue,
  MetricThresholds,
  PoolKind,
  ProjectConfig,
  ProvinoConfigInput,
} from '@provino/types'
import { ConfigError } from '../errors.ts'

/** The tiers config may name. */
const ISOLATION_TIERS: readonly IsolationTier[] = ['none', 'registry', 'realm', 'process']

const POOL_KINDS: readonly PoolKind[] = ['forks', 'threads', 'inline']

/** The keys every project reads (`BaseConfig` and the project keys), in the order they are listed in messages. */
const PROJECT_KEYS: readonly string[] = Object.keys({
  include: true,
  exclude: true,
  environment: true,
  isolation: true,
  globals: true,
  setupFiles: true,
  environmentOptions: true,
  timeouts: true,
  resolve: true,
  define: true,
  dialects: true,
  plugins: true,
  name: true,
  root: true,
  dialect: true,
  alsoServe: true,
} satisfies Record<keyof BaseConfig | 'name' | 'root' | 'dialect' | 'alsoServe', true>)

/** The keys only the top-level config has. */
const TOP_LEVEL_KEYS: readonly string[] = Object.keys({
  projects: true,
  pool: true,
  maxWorkers: true,
  execArgv: true,
  coverage: true,
} satisfies Record<Exclude<keyof ProvinoConfigInput, keyof ProjectConfig>, true>)

const COVERAGE_KEYS: readonly string[] = Object.keys({
  enabled: true,
  provider: true,
  include: true,
  exclude: true,
  reporters: true,
  directory: true,
  thresholds: true,
} satisfies Record<keyof ConfigCoverage, true>)

/** The reporters `istanbul-reports` has, which `coverage.reporters` may name. */
const COVERAGE_REPORTERS: readonly string[] = Object.keys({
  clover: true,
  cobertura: true,
  html: true,
  'html-spa': true,
  json: true,
  'json-summary': true,
  lcov: true,
  lcovonly: true,
  none: true,
  teamcity: true,
  text: true,
  'text-lcov': true,
  'text-summary': true,
} satisfies Record<CoverageReporterName, true>)

const COVERAGE_METRICS: readonly string[] = Object.keys({
  statements: true,
  branches: true,
  functions: true,
  lines: true,
} satisfies Record<keyof MetricThresholds, true>)

const TIMEOUT_KEYS: readonly string[] = Object.keys({
  test: true,
  hook: true,
  teardown: true,
} satisfies Record<keyof ConfigTimeouts, true>)
const RESOLVE_KEYS: readonly string[] = Object.keys({
  conditions: true,
  aliases: true,
  tsconfig: true,
} satisfies Record<keyof ConfigResolve, true>)

/** The `name` of each plugin a config lists, for the keys it may carry. */
function pluginNamesOf(input: Readonly<Record<string, unknown>>): readonly string[] {
  const plugins: unknown = Reflect.get(input, 'plugins')
  return Array.isArray(plugins)
    ? plugins.flatMap((plugin: unknown) =>
        isRecord(plugin) && typeof plugin.name === 'string' ? [plugin.name] : [],
      )
    : []
}

/**
 * The keys a config may carry: the project keys, the run's (top level only), the name of each of
 * `dialects` (a dialect's options) and of each plugin it lists. `parseInput`'s
 * `CONFIG_UNKNOWN_KEY` and `needsMoreDialects` both read this one list, so the lazy load can't
 * drift from the check.
 */
function knownKeys(
  input: Readonly<Record<string, unknown>>,
  dialects: readonly Dialect[],
  topLevel: boolean,
): readonly string[] {
  return [
    ...PROJECT_KEYS,
    ...(topLevel ? TOP_LEVEL_KEYS : []),
    ...dialects.map((dialect) => dialect.name),
    ...pluginNamesOf(input),
  ]
}

/**
 * Whether `input` may need a dialect that `known` lacks: it names a `dialect` that isn't there,
 * or has an own key `knownKeys` doesn't hold (a dialect's options key, `jest`). A config with its
 * own `dialects` never does (they replace the caller's). Read before `parseInput`, so it trusts
 * nothing: a key that turns out to be wrong is reported by `parseInput` as before.
 * @internal
 */
export function needsMoreDialects(
  input: ProvinoConfigInput,
  known: readonly Dialect[],
  topLevel: boolean,
): boolean {
  if (!isRecord(input) || input.dialects !== undefined) return false
  if (typeof input.dialect === 'string' && !known.some((d) => d.name === input.dialect)) return true
  const keys = new Set(knownKeys(input, known, topLevel))
  return Object.keys(input).some((key) => !keys.has(key))
}

/**
 * The keys of a project's config that `resolveProject` reads, each checked to be what its type
 * says. A file's default export is data from `import()`, so it is parsed here once and trusted
 * after.
 * @internal
 */
export interface ParsedInput {
  readonly name: string | undefined
  readonly root: string | undefined
  readonly dialect: string | undefined
  readonly dialects: readonly Dialect[] | undefined
  readonly include: readonly string[] | undefined
  readonly exclude: readonly string[] | undefined
  readonly environment: string | undefined
  readonly isolation: IsolationTier | undefined
  readonly globals: boolean | undefined
  readonly setupFiles: readonly string[] | undefined
  readonly environmentOptions: Readonly<Record<string, JsonValue>> | undefined
  readonly timeouts: ConfigTimeouts | undefined
  readonly resolve: ConfigResolve | undefined
  /** `define` as the source text of each replacement (a string as written, any other value as JSON). */
  readonly define: Readonly<Record<string, string>> | undefined
  /** Top-level only: the defaults `run` takes when the command line names none. */
  readonly pool: PoolKind | undefined
  readonly maxWorkers: number | undefined
  readonly execArgv: readonly string[] | undefined
  /** Top-level only: the run's code coverage. */
  readonly coverage: ConfigCoverage | undefined
  /** Top-level only: the entries of `projects`, each a path or glob, or an inline project. */
  readonly projects: readonly (ProjectConfig | string)[] | undefined
}

/**
 * Keys that parse but are not supported yet. A non-empty value for one is `CONFIG_UNSUPPORTED`:
 * ignoring it silently would run something other than what the file says.
 */
const UNSUPPORTED: readonly string[] = ['plugins', 'alsoServe']

/** Whether a value is a non-null object that is not an array. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A short description of a value for a message. */
export function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
  }
  if (typeof value === 'object' || typeof value === 'function') return `a ${typeof value}`
  return `${typeof value} ${String(value)}`
}

function invalid(key: string, expected: string, value: unknown): ConfigError {
  return new ConfigError(
    'CONFIG_INVALID',
    `config key "${key}" must be ${expected} (got ${describe(value)})`,
  )
}

/** Whether a value is a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** An error's message, or the text of whatever was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a value is an array of strings. */
export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString)
}

/** `input[key]` when it is absent (`undefined`) or passes `guard`, else `CONFIG_INVALID`. */
function optional<Value>(
  input: object,
  key: string,
  expected: string,
  guard: (value: unknown) => value is Value,
): Value | undefined {
  const value: unknown = Reflect.get(input, key)
  if (value === undefined) return undefined
  if (!guard(value)) throw invalid(key, expected, value)
  return value
}

function isDialect(value: unknown): value is Dialect {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') return false
  return typeof value.policy === 'function' || isRecord(value.policy)
}

function isDialectList(value: unknown): value is readonly Dialect[] {
  return Array.isArray(value) && value.every(isDialect)
}

function isTier(value: unknown): value is IsolationTier {
  return ISOLATION_TIERS.some((candidate) => candidate === value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && isJsonValue(value)
}

function isPoolKind(value: unknown): value is PoolKind {
  return POOL_KINDS.some((candidate) => candidate === value)
}

function isWorkerCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Node flags for the workers: non-empty strings, the first one a flag. A value may follow its flag
 * as an entry of its own (`['--require', file]`), but one that comes first, or an empty entry,
 * would reach `node` as the script to run.
 */
function isNodeFlags(value: unknown): value is readonly string[] {
  return (
    isStringArray(value) &&
    value.every((entry) => entry !== '') &&
    (value[0] === undefined || value[0].startsWith('-'))
  )
}

function isCoverageReporterName(value: unknown): value is CoverageReporterName {
  return COVERAGE_REPORTERS.some((name) => name === value)
}

function isCoverageReporterEntry(
  value: unknown,
): value is
  | CoverageReporterName
  | readonly [CoverageReporterName, Readonly<Record<string, JsonValue>>] {
  if (isCoverageReporterName(value)) return true
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isCoverageReporterName(value[0]) &&
    isJsonRecord(value[1])
  )
}

function isCoverageReporters(value: unknown): value is NonNullable<ConfigCoverage['reporters']> {
  return Array.isArray(value) && value.every(isCoverageReporterEntry)
}

function isCoverageProvider(value: unknown): value is NonNullable<ConfigCoverage['provider']> {
  return value === 'v8' || value === 'istanbul'
}

/** `{ global: { lines: 80 }, 'src/a.ts': { statements: -2 } }`: the metrics are numbers. */
function parseThresholds(coverage: object): void {
  const value = optional(coverage, 'thresholds', 'an object of threshold groups', isRecord)
  if (value === undefined) return
  for (const [name, group] of Object.entries(value)) {
    const path = `coverage.thresholds.${name}`
    if (!isRecord(group)) throw invalid(path, 'an object of metric thresholds', group)
    assertKnownKeys(group, COVERAGE_METRICS, path)
    for (const metric of COVERAGE_METRICS) {
      const threshold: unknown = Reflect.get(group, metric)
      if (
        threshold !== undefined &&
        (typeof threshold !== 'number' || !Number.isFinite(threshold))
      ) {
        throw invalid(`${path}.${metric}`, 'a number', threshold)
      }
    }
  }
}

function parseCoverage(input: object): ConfigCoverage | undefined {
  const value = optional(input, 'coverage', 'an object', isRecord)
  if (value === undefined) return undefined
  assertKnownKeys(value, COVERAGE_KEYS, 'coverage')
  optional(value, 'enabled', 'a boolean', isBoolean)
  optional(value, 'provider', '"v8" or "istanbul"', isCoverageProvider)
  optional(value, 'include', 'an array of strings', isStringArray)
  optional(value, 'exclude', 'an array of strings', isStringArray)
  optional(
    value,
    'reporters',
    `an array of reporter names (${COVERAGE_REPORTERS.join(', ')}), each alone or as [name, options]`,
    isCoverageReporters,
  )
  optional(value, 'directory', 'a string', isString)
  parseThresholds(value)
  return value
}

function isProjectEntries(value: unknown): value is readonly (ProjectConfig | string)[] {
  return Array.isArray(value) && value.every((entry) => isString(entry) || isRecord(entry))
}

/** Edit distance between two strings (Levenshtein), for the nearest-key suggestion. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let row = 1; row <= a.length; row++) {
    const current = [row]
    for (let column = 1; column <= b.length; column++) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1
      current.push(
        Math.min(
          (previous[column] ?? 0) + 1,
          (current[column - 1] ?? 0) + 1,
          (previous[column - 1] ?? 0) + cost,
        ),
      )
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/** The known key nearest to `key` when it is close enough to be a typo, else `undefined`. */
function nearestKey(key: string, known: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of known) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return bestDistance <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined
}

/**
 * Refuses an own key of `value` that isn't in `known`: `CONFIG_UNKNOWN_KEY` naming the key (as
 * `path` gives it) and the nearest known one. A typo would otherwise be ignored and run something
 * other than what the file says.
 */
function assertKnownKeys(
  value: object,
  known: readonly string[],
  path: string,
  topLevelOnly: readonly string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue
    if (topLevelOnly.includes(key)) {
      throw new ConfigError(
        'CONFIG_UNKNOWN_KEY',
        `config key "${key}" belongs to the top-level config only: a project doesn't take it`,
      )
    }
    const nearest = nearestKey(key, known)
    const where = path === '' ? `config key "${key}"` : `key "${key}" of config key "${path}"`
    throw new ConfigError(
      'CONFIG_UNKNOWN_KEY',
      nearest === undefined
        ? `unknown ${where}; the known keys are ${known.map((name) => `"${name}"`).join(', ')}`
        : `unknown ${where}; did you mean "${nearest}"?`,
      path === '' ? { subject: key } : undefined,
    )
  }
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseTimeouts(input: object): ConfigTimeouts | undefined {
  const value = optional(input, 'timeouts', 'an object', isRecord)
  if (value === undefined) return undefined
  assertKnownKeys(value, TIMEOUT_KEYS, 'timeouts')
  for (const key of TIMEOUT_KEYS) {
    const timeout: unknown = Reflect.get(value, key)
    if (timeout !== undefined && !isNonNegativeNumber(timeout)) {
      throw invalid(`timeouts.${key}`, 'a number of milliseconds, 0 or more', timeout)
    }
  }
  return value
}

function isTsconfig(value: unknown): value is ConfigResolve['tsconfig'] {
  return value === false || typeof value === 'string'
}

function isAliasMap(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every(isString)
}

function parseResolve(input: object): ConfigResolve | undefined {
  const value = optional(input, 'resolve', 'an object', isRecord)
  if (value === undefined) return undefined
  assertKnownKeys(value, RESOLVE_KEYS, 'resolve')
  optional(value, 'conditions', 'an array of strings', isStringArray)
  optional(value, 'aliases', 'an object of strings', isAliasMap)
  optional(value, 'tsconfig', '"auto", false or a path', isTsconfig)
  return value
}

/** An identifier or a dotted chain of them: `__X__`, `process.env.NODE_ENV`, `import.meta.env`. */
const DEFINE_KEY = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

/**
 * `define`: a string is an expression's source text as written, any other JSON value is its JSON
 * text (the rule Vite's `define` has; unverified against its source). A key or value that is
 * neither is `CONFIG_INVALID` naming `define["<key>"]`.
 */
function parseDefine(input: object): Readonly<Record<string, string>> | undefined {
  const value = optional(input, 'define', 'an object', isRecord)
  if (value === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, replacement] of Object.entries(value)) {
    const name = `define[${JSON.stringify(key)}]`
    if (!DEFINE_KEY.test(key)) {
      throw invalid(name, 'a key that is an identifier or a dotted chain of them', key)
    }
    if (typeof replacement === 'string') {
      if (replacement.trim() === '') throw invalid(name, 'a non-blank expression', replacement)
      out[key] = replacement
    } else if (isJsonValue(replacement)) {
      out[key] = JSON.stringify(replacement)
    } else {
      throw invalid(name, 'a string of source text or a JSON value', replacement)
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Checks the keys `resolveProject` reads, and refuses the ones nothing handles yet. A key that
 * isn't one of them is `CONFIG_UNKNOWN_KEY`, unless it is the name of a dialect in `dialects` (the
 * config's own, else `defaultDialects`: the options of a dialect the project doesn't list are
 * not a key) or of a plugin the config lists. `topLevel` is false for an inline project, which
 * takes none of the keys that belong to the whole run.
 * @internal
 */
export function parseInput(
  input: ProvinoConfigInput,
  defaultDialects: readonly Dialect[],
  topLevel = true,
): ParsedInput {
  if (!isRecord(input)) {
    throw new ConfigError('CONFIG_INVALID', `the config must be an object (got ${describe(input)})`)
  }
  const dialects = optional(
    input,
    'dialects',
    'an array of dialects (each with a name and a policy)',
    isDialectList,
  )
  assertKnownKeys(
    input,
    knownKeys(input, dialects ?? defaultDialects, topLevel),
    '',
    topLevel ? [] : TOP_LEVEL_KEYS,
  )
  for (const key of UNSUPPORTED) {
    const value: unknown = Reflect.get(input, key)
    if (value === undefined) continue
    if (!Array.isArray(value)) throw invalid(key, 'an array', value)
    if (value.length > 0) {
      throw new ConfigError('CONFIG_UNSUPPORTED', `config key "${key}" isn't supported yet`)
    }
  }
  return {
    name: optional(input, 'name', 'a string', isString),
    root: optional(input, 'root', 'a string', isString),
    dialect: optional(input, 'dialect', 'a string', isString),
    dialects,
    include: optional(input, 'include', 'an array of strings', isStringArray),
    exclude: optional(input, 'exclude', 'an array of strings', isStringArray),
    environment: optional(input, 'environment', 'a string', isString),
    isolation: optional(
      input,
      'isolation',
      `one of ${ISOLATION_TIERS.map((t) => `"${t}"`).join(', ')}`,
      isTier,
    ),
    globals: optional(input, 'globals', 'a boolean', isBoolean),
    setupFiles: optional(input, 'setupFiles', 'an array of strings', isStringArray),
    environmentOptions: optional(
      input,
      'environmentOptions',
      'an object of JSON values',
      isJsonRecord,
    ),
    timeouts: parseTimeouts(input),
    resolve: parseResolve(input),
    define: parseDefine(input),
    pool: optional(
      input,
      'pool',
      `one of ${POOL_KINDS.map((kind) => `"${kind}"`).join(', ')}`,
      isPoolKind,
    ),
    maxWorkers: optional(input, 'maxWorkers', 'a whole number of at least 1', isWorkerCount),
    execArgv: optional(
      input,
      'execArgv',
      'an array of Node flags (non-empty strings, the first one starting with "-")',
      isNodeFlags,
    ),
    coverage: topLevel ? parseCoverage(input) : undefined,
    projects: optional(
      input,
      'projects',
      'an array of paths, globs and inline projects',
      isProjectEntries,
    ),
  }
}
