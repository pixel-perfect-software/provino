// T11.13: what bare `provino` runs. Gap 8 of B14: a `provino.config.*` first, then the runner the
// project's own config names. D200: the nearest directory holding any config wins.
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { findConfigInDirectory } from '@provino/config'
import { UsageError } from './usage-error.ts'

/**
 * What a project directory is, and the directory whose config says so.
 * @internal
 */
export type DetectedProject =
  | { readonly kind: 'provino'; readonly config: string; readonly directory: string }
  | { readonly kind: 'jest'; readonly directory: string }
  | { readonly kind: 'vitest'; readonly directory: string }

const VITEST_CONFIG = /^vitest\.(config|workspace)\.(ts|mts|cts|js|mjs|cjs|json)$/
const VITE_CONFIG = /^vite\.config\.(ts|mts|cts|js|mjs|cjs)$/

/**
 * The Jest config files a directory may hold besides `package.json`: jest-config 30.5.2's
 * `JEST_CONFIG_EXT_ORDER` after `jest.config`. A copy of `@provino/dialect-jest/node`'s
 * `JEST_CONFIG_CANDIDATES` (`detect.test.ts` holds them equal), so the walk loads no Jest dialect
 * code on a native project (D115, `speed`; B27f installs the dialect apart).
 * @internal
 */
export const JEST_CONFIG_FILES: readonly string[] = [
  'jest.config.js',
  'jest.config.ts',
  'jest.config.mjs',
  'jest.config.mts',
  'jest.config.cjs',
  'jest.config.cts',
  'jest.config.json',
]

/** What ends the walk up (D196): a directory holding one of these is the top of a project or workspace. */
const ROOT_MARKERS: readonly string[] = ['.git', 'pnpm-workspace.yaml']

/** Whether `package.json` at `path` has a `jest` key (a Jest source may be a `package.json` without one). */
async function hasJestKey(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && 'jest' in parsed
  } catch {
    return false
  }
}

/** Whether `directory`'s `vite.config.*` has a `test` key; the reader loads only when there is one. */
async function declaresTests(directory: string): Promise<boolean> {
  try {
    const { viteConfigDeclaresTests } = await import('@provino/dialect-vitest/node')
    return await viteConfigDeclaresTests(directory)
  } catch {
    // A `vite.config.*` that doesn't load is not evidence of a Vitest project: a Jest project may
    // carry one for its bundler, and a project with only that one is reported as having no config.
    return false
  }
}

/** Whether `directory` itself holds a Jest config (a `package.json` counts only with a `jest` key). */
async function holdsJest(directory: string, names: ReadonlySet<string>): Promise<boolean> {
  if (JEST_CONFIG_FILES.some((name) => names.has(name))) return true
  return names.has('package.json') && (await hasJestKey(join(directory, 'package.json')))
}

/**
 * Decides what to run from `cwd` (D200). A forced dialect (`--dialect`) skips the search.
 * Otherwise it walks up from `cwd`, and the first directory that holds any config decides: its
 * `provino.config.*`, else its Jest config (a `package.json` counting only with a `jest` key),
 * else its `vitest.config.*`/`vitest.workspace.*`, or a `vite.config.*` with a `test` key (read
 * once, by importing it, with no Vite: B25c). A Jest and a Vitest config in one directory is an
 * error, and a `provino.config.*` beside either wins. The walk stops after a directory with
 * `.git` or `pnpm-workspace.yaml` (D196), and none found is an error. No dialect code loads
 * for the walk; the Vitest reader loads only for a `vite.config.*` that must be read.
 * @internal
 */
export async function detectProject(
  cwd: string,
  forced?: 'jest' | 'vitest',
): Promise<DetectedProject> {
  if (forced !== undefined) return { kind: forced, directory: cwd }
  let directory = cwd
  for (;;) {
    const config = await findConfigInDirectory(directory)
    if (config !== undefined) return { kind: 'provino', config, directory }
    const names = new Set(await readdir(directory).catch(() => [] as string[]))
    const jest = await holdsJest(directory, names)
    // A Jest config settles it: `vite.config.*` is read only when nothing else says what this is.
    const vitest =
      [...names].some((name) => VITEST_CONFIG.test(name)) ||
      (!jest &&
        [...names].some((name) => VITE_CONFIG.test(name)) &&
        (await declaresTests(directory)))
    if (jest && vitest) {
      throw new UsageError(
        `found both a Jest config and a Vitest config in ${directory}: say which one to run with --dialect jest or --dialect vitest`,
      )
    }
    if (jest) return { kind: 'jest', directory }
    if (vitest) return { kind: 'vitest', directory }
    const parent = dirname(directory)
    if (ROOT_MARKERS.some((marker) => names.has(marker)) || parent === directory) break
    directory = parent
  }
  throw new UsageError(
    `found no provino.config.*, Jest config or Vitest config in ${cwd} or a parent directory (provino jest runs a Jest project with Jest's defaults)`,
  )
}
