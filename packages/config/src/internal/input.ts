import type { Dialect, IsolationTier, ProvinoConfigInput } from '@provino/types'
import { ConfigError } from '../errors.ts'

/** The tiers config may name. */
const ISOLATION_TIERS: readonly IsolationTier[] = ['none', 'registry', 'realm', 'process']

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
}

/**
 * Keys that parse but have no owner yet, with who builds them. A non-empty value for one is
 * `CONFIG_UNSUPPORTED`: ignoring it silently would run something other than what the file says.
 */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  projects: 'T1.4 (multi-project config)',
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

/**
 * Checks the keys `resolveProject` reads, and refuses the ones nothing handles yet.
 * @internal
 */
export function parseInput(input: ProvinoConfigInput): ParsedInput {
  if (!isRecord(input)) {
    throw new ConfigError('CONFIG_INVALID', `the config must be an object (got ${describe(input)})`)
  }
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
    dialects: optional(
      input,
      'dialects',
      'an array of dialects (each with a name and a policy)',
      isDialectList,
    ),
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
  }
}
