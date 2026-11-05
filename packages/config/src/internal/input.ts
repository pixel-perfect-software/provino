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

function string(input: object, key: string): string | undefined {
  const value: unknown = Reflect.get(input, key)
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(key, 'a string', value)
  return value
}

function strings(input: object, key: string): readonly string[] | undefined {
  const value: unknown = Reflect.get(input, key)
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(isString)) {
    throw invalid(key, 'an array of strings', value)
  }
  return value
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function dialects(input: object): readonly Dialect[] | undefined {
  const value: unknown = Reflect.get(input, 'dialects')
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(isDialect)) {
    throw invalid('dialects', 'an array of dialects (each with a name and a policy)', value)
  }
  return value
}

function isDialect(value: unknown): value is Dialect {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') return false
  return typeof value.policy === 'function' || isRecord(value.policy)
}

function isolation(input: object): IsolationTier | undefined {
  const value: unknown = Reflect.get(input, 'isolation')
  if (value === undefined) return undefined
  const tier = ISOLATION_TIERS.find((candidate) => candidate === value)
  if (tier === undefined) {
    throw invalid('isolation', `one of ${ISOLATION_TIERS.map((t) => `"${t}"`).join(', ')}`, value)
  }
  return tier
}

function boolean(input: object, key: string): boolean | undefined {
  const value: unknown = Reflect.get(input, key)
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw invalid(key, 'a boolean', value)
  return value
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
    name: string(input, 'name'),
    root: string(input, 'root'),
    dialect: string(input, 'dialect'),
    dialects: dialects(input),
    include: strings(input, 'include'),
    exclude: strings(input, 'exclude'),
    environment: string(input, 'environment'),
    isolation: isolation(input),
    globals: boolean(input, 'globals'),
    setupFiles: strings(input, 'setupFiles'),
  }
}
