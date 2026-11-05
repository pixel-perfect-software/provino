import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DetectContext, Dialect, PolicyOverrides } from '@provino/types'
import { ConfigError, type ConfigIssue } from '../errors.ts'
import { isRecord } from './input.ts'

/** The names of `dialects`, for a message. */
function namesOf(dialects: readonly Dialect[]): string {
  return dialects.length === 0 ? 'none' : dialects.map((d) => `"${d.name}"`).join(', ')
}

/**
 * What `detect` sees: the names of the files directly in the project root, and its parsed
 * `package.json` when it has one. A dialect looks for its own config file by name (`jest.config.js`).
 */
async function detectContext(rootDir: string): Promise<DetectContext> {
  let configFiles: readonly string[]
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    configFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .toSorted()
  } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', `can't read the project root "${rootDir}"`, { cause })
  }
  let packageJson: Readonly<Record<string, unknown>> | undefined
  if (configFiles.includes('package.json')) {
    const path = join(rootDir, 'package.json')
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (isRecord(parsed)) packageJson = parsed
    } catch (cause) {
      throw new ConfigError('CONFIG_INVALID', `can't read "${path}" to detect the dialect`, {
        cause,
      })
    }
  }
  return { root: rootDir, packageJson, configFiles }
}

/**
 * Picks the project's dialect. A name picks it from `known`; no name picks the one with the
 * highest `detect` score above zero; a tie is an error rather than a guess, and no match is
 * neutral (`null`).
 * @internal
 */
export async function selectDialect(
  requested: string | undefined,
  known: readonly Dialect[],
  rootDir: string,
): Promise<Dialect | null> {
  if (requested !== undefined) {
    const found = known.find((dialect) => dialect.name === requested)
    if (found === undefined) {
      throw new ConfigError(
        'CONFIG_UNKNOWN_DIALECT',
        `unknown dialect "${requested}"; the known dialects are ${namesOf(known)}`,
      )
    }
    return found
  }
  const detecting = known.filter((dialect) => dialect.detect !== undefined)
  if (detecting.length === 0) return null
  const context = await detectContext(rootDir)
  const scored = await Promise.all(
    detecting.map(async (dialect) => ({ dialect, score: await score(dialect, context) })),
  )
  const best = Math.max(0, ...scored.map((entry) => entry.score))
  if (best === 0) return null
  const winners = scored.filter((entry) => entry.score === best).map((entry) => entry.dialect)
  const [winner] = winners
  if (winners.length > 1 || winner === undefined) {
    throw new ConfigError(
      'CONFIG_DIALECT_TIE',
      `the dialects ${namesOf(winners)} fit this project equally well (score ${best}); name one with the "dialect" config key`,
    )
  }
  return winner
}

/** A dialect's `detect` score; anything that isn't a positive number is no fit. */
async function score(dialect: Dialect, context: DetectContext): Promise<number> {
  try {
    const value = await dialect.detect?.(context)
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  } catch (cause) {
    throw new ConfigError('CONFIG_LOAD_FAILED', `the "${dialect.name}" dialect's detect failed`, {
      cause,
    })
  }
}

function issueOf(issue: {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}): ConfigIssue {
  const path = (issue.path ?? [])
    .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.')
  return { path, message: issue.message }
}

/**
 * The dialect's policy layer. A plain layer is used as it is. A factory gets the options at
 * `config[dialect.name]`, checked against `dialect.options` first when the dialect has a schema
 * (the factory is typed to accept anything, so it can't check them itself).
 * @internal
 */
export async function dialectPolicy(dialect: Dialect, options: unknown): Promise<PolicyOverrides> {
  const { policy } = dialect
  if (typeof policy !== 'function') return policy
  let checked = options
  const schema = dialect.options
  if (schema !== undefined) {
    let result: Awaited<ReturnType<(typeof schema)['~standard']['validate']>>
    try {
      result = await schema['~standard'].validate(options)
    } catch (cause) {
      throw new ConfigError(
        'CONFIG_BAD_DIALECT_OPTIONS',
        `the "${dialect.name}" dialect's options schema threw`,
        { cause },
      )
    }
    if (result.issues !== undefined) {
      const issues = result.issues.map(issueOf)
      const lines = issues.map((i) => `  ${i.path === '' ? '(options)' : i.path}: ${i.message}`)
      throw new ConfigError(
        'CONFIG_BAD_DIALECT_OPTIONS',
        `invalid options for the "${dialect.name}" dialect:\n${lines.join('\n')}`,
        { issues },
      )
    }
    checked = result.value
  }
  try {
    return policy(checked)
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_BAD_DIALECT_OPTIONS',
      `the "${dialect.name}" dialect couldn't build its policy from its options`,
      { cause },
    )
  }
}
