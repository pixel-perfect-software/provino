// T11.13: what bare `provino` runs. Gap 8 of B14: a `provino.config.*` first, then the runner the
// project's own config names.
import { readdir, readFile } from 'node:fs/promises'
import { findConfigUpward } from '@provino/config'
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

const VITEST_CONFIG = /^vitest\.(config|workspace)\.(ts|mts|cts|js|mjs|cjs|json)$/
const VITE_CONFIG = /^vite\.config\.(ts|mts|cts|js|mjs|cjs)$/

/** Whether `package.json` at `path` has a `jest` key (a Jest source may be a `package.json` without one). */
async function hasJestKey(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && 'jest' in parsed
  } catch {
    return false
  }
}

/** Whether `cwd`'s `vite.config.*` has a `test` key; the reader loads only when there is one. */
async function declaresTests(cwd: string): Promise<boolean> {
  try {
    const { viteConfigDeclaresTests } = await import('@provino/dialect-vitest/node')
    return await viteConfigDeclaresTests(cwd)
  } catch {
    // A `vite.config.*` that doesn't load is not evidence of a Vitest project: a Jest project may
    // carry one for its bundler, and a project with only that one is reported as having no config.
    return false
  }
}

async function findsJest(cwd: string): Promise<boolean> {
  const source = await jestNodeDialect.configReader?.find(cwd)
  if (source === undefined) return false
  return source.kind === 'package-json' ? hasJestKey(source.path) : true
}

/**
 * Decides what to run in `cwd`. A forced dialect (`--dialect`) skips the search. Otherwise the
 * first `provino.config.*` found walking up from `cwd` wins (D196: it stops at a directory with
 * `.git` or `pnpm-workspace.yaml`), and the Jest code is not loaded; else the Jest config found from `cwd` (the upward walk Jest
 * does, a `package.json` counting only with a `jest` key) or a `vitest.config.*`/
 * `vitest.workspace.*` in `cwd`, or a `vite.config.*` there with a `test` key (read once, by
 * importing it, with no Vite: B25c); both is an error, and none is too.
 * @internal
 */
export async function detectProject(
  cwd: string,
  forced?: 'jest' | 'vitest',
): Promise<DetectedProject> {
  if (forced !== undefined) return { kind: forced }
  const config = await findConfigUpward(cwd)
  if (config !== undefined) return { kind: 'provino', config }
  const names = new Set(await readdir(cwd).catch(() => [] as string[]))
  const jest = await findsJest(cwd)
  // A Jest config settles it: `vite.config.*` is read only when nothing else says what this is.
  const vitest =
    [...names].some((name) => VITEST_CONFIG.test(name)) ||
    (!jest && [...names].some((name) => VITE_CONFIG.test(name)) && (await declaresTests(cwd)))
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
