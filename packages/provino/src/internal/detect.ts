// T11.13: what bare `provino` runs. Gap 8 of B14: a `provino.config.*` first, then the runner the
// project's own config names.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { jestNodeDialect } from '@provino/dialect-jest/node'
import { UsageError } from './usage-error.ts'

/**
 * What a project directory is.
 * @internal
 */
export type DetectedProject =
  | { readonly kind: 'provino'; readonly config: string }
  | { readonly kind: 'jest' }
  | { readonly kind: 'vitest' }

/** The extensions a `provino.config.*` may have, in the order they are looked for. */
const PROVINO_CONFIG_EXTENSIONS: readonly string[] = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']

const VITEST_CONFIG = /^vitest\.(config|workspace)\.(ts|mts|cts|js|mjs|cjs|json)$/

/** Whether `package.json` at `path` has a `jest` key (a Jest source may be a `package.json` without one). */
async function hasJestKey(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && 'jest' in parsed
  } catch {
    return false
  }
}

async function findsJest(cwd: string): Promise<boolean> {
  const source = await jestNodeDialect.configReader?.find(cwd)
  if (source === undefined) return false
  return source.kind === 'package-json' ? hasJestKey(source.path) : true
}

/**
 * Decides what to run in `cwd`. A forced dialect (`--dialect`) skips the search. Otherwise a
 * `provino.config.*` in `cwd` wins; else the Jest config found from `cwd` (the upward walk Jest
 * does, a `package.json` counting only with a `jest` key) or a `vitest.config.*`/
 * `vitest.workspace.*` in `cwd`; both is an error, and none is too. (A `vite.config.*` with a
 * `test` key is a Vitest project too, but telling needs Vite: T11.15.)
 * @internal
 */
export async function detectProject(
  cwd: string,
  forced?: 'jest' | 'vitest',
): Promise<DetectedProject> {
  if (forced !== undefined) return { kind: forced }
  const names = new Set(await readdir(cwd).catch(() => [] as string[]))
  for (const extension of PROVINO_CONFIG_EXTENSIONS) {
    const name = `provino.config.${extension}`
    if (names.has(name)) return { kind: 'provino', config: join(cwd, name) }
  }
  const jest = await findsJest(cwd)
  const vitest = [...names].some((name) => VITEST_CONFIG.test(name))
  if (jest && vitest) {
    throw new UsageError(
      'found both a Jest config and a Vitest config here: say which one to run with --dialect jest or --dialect vitest',
    )
  }
  if (jest) return { kind: 'jest' }
  if (vitest) return { kind: 'vitest' }
  throw new UsageError(
    `found no provino.config.*, Jest config or Vitest config in ${cwd} (provino jest runs a Jest project with Jest's defaults)`,
  )
}
