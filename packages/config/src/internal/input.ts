import type {
  ConfigResolve,
  ConfigTimeouts,
  Dialect,
  IsolationTier,
  JsonValue,
  PoolKind,
  ProjectConfig,
  ProvinoConfigInput,
} from '@provino/types'
import { ConfigError } from '../errors.ts'

/** The tiers config may name. */
const ISOLATION_TIERS: readonly IsolationTier[] = ['none', 'registry', 'realm', 'process']

const POOL_KINDS: readonly PoolKind[] = ['forks', 'threads', 'inline']

/** The keys every project reads (`BaseConfig` and the project keys). */
const PROJECT_KEYS: readonly string[] = [
  'include',
  'exclude',
  'environment',
  'isolation',
  'globals',
  'setupFiles',
  'environmentOptions',
  'timeouts',
  'resolve',
  'dialects',
  'plugins',
  'name',
  'root',
  'dialect',
  'alsoServe',
]

/** The keys only the top-level config has. */
const TOP_LEVEL_KEYS: readonly string[] = ['projects', 'pool', 'maxWorkers']

const TIMEOUT_KEYS: readonly string[] = ['test', 'hook', 'teardown']
const RESOLVE_KEYS: readonly string[] = ['conditions', 'aliases', 'tsconfig']

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
  /** Top-level only: the defaults `run` takes when the command line names none. */
  readonly pool: PoolKind | undefined
  readonly maxWorkers: number | undefined
  /** Top-level only: the entries of `projects`, each a path or glob, or an inline project. */
  readonly projects: readonly (ProjectConfig | string)[] | undefined
}

/**
 * Keys that parse but have no owner yet, with who builds them. A non-empty value for one is
 * `CONFIG_UNSUPPORTED`: ignoring it silently would run something other than what the file says.
 */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  plugins: 'T1.4 (plugins)',
  alsoServe: 'T1.4 (a project serving several dialects)',
}

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
function assertKnownKeys(value: object, known: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue
    const nearest = nearestKey(key, known)
    const where = path === '' ? `config key "${key}"` : `key "${key}" of config key "${path}"`
    throw new ConfigError(
      'CONFIG_UNKNOWN_KEY',
      nearest === undefined
        ? `unknown ${where}; the known keys are ${known.map((name) => `"${name}"`).join(', ')}`
        : `unknown ${where}; did you mean "${nearest}"?`,
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
  const plugins: unknown = Reflect.get(input, 'plugins')
  const pluginNames = Array.isArray(plugins)
    ? plugins.flatMap((plugin: unknown) =>
        isRecord(plugin) && typeof plugin.name === 'string' ? [plugin.name] : [],
      )
    : []
  assertKnownKeys(
    input,
    [
      ...PROJECT_KEYS,
      ...(topLevel ? TOP_LEVEL_KEYS : []),
      ...(dialects ?? defaultDialects).map((dialect) => dialect.name),
      ...pluginNames,
    ],
    '',
  )
  for (const [key, owner] of Object.entries(UNSUPPORTED)) {
    const value: unknown = Reflect.get(input, key)
    if (value === undefined) continue
    if (!Array.isArray(value)) throw invalid(key, 'an array', value)
    if (value.length > 0) {
      throw new ConfigError(
        'CONFIG_UNSUPPORTED',
        `config key "${key}" isn't supported yet; ${owner} builds it`,
      )
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
    pool: optional(
      input,
      'pool',
      `one of ${POOL_KINDS.map((kind) => `"${kind}"`).join(', ')}`,
      isPoolKind,
    ),
    maxWorkers: optional(input, 'maxWorkers', 'a whole number of at least 1', isWorkerCount),
    projects: optional(
      input,
      'projects',
      'an array of paths, globs and inline projects',
      isProjectEntries,
    ),
  }
}
