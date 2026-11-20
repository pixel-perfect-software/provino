// B25c, T11.15: where a Vitest config is. Vitest 5.0.5 looks in the root only, never upward
// (`findConfigFile`, `node/config/resolveConfig.ts` L55-L64), for `vitest.config.*` and then
// `vite.config.*` (`constants.ts` L5-L14); the first that exists wins and the two are not merged.
import { resolve } from 'node:path'
import type { ConfigSource } from '@provino/types'
import { VitestConfigError } from './errors.ts'
import { firstExisting, isFile } from './util.ts'

const CONFIG_NAMES: readonly string[] = ['vitest.config', 'vite.config']
const CONFIG_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']

/**
 * The file names looked for in the root, in Vitest's order.
 * @public
 */
export const VITEST_CONFIG_CANDIDATES: readonly string[] = CONFIG_NAMES.flatMap((name) =>
  CONFIG_EXTENSIONS.map((extension) => name + extension),
)

/** Vitest 4 dropped `vitest.workspace.*`; a file by that name is not read. */
const WORKSPACE_CANDIDATES: readonly string[] = [
  ...CONFIG_EXTENSIONS.map((extension) => `vitest.workspace${extension}`),
  'vitest.workspace.json',
]

/**
 * The config for `root`: the file `explicit` names (relative to `root`), else the first of
 * `VITEST_CONFIG_CANDIDATES` in `root`. `undefined` when an implicit search finds none (Vitest
 * then runs on its defaults); an explicit path that is no file throws.
 * @public
 */
export function findVitestConfig(root: string, explicit?: string): ConfigSource | undefined {
  if (explicit !== undefined) {
    const path = resolve(root, explicit)
    if (!isFile(path)) {
      throw new VitestConfigError(
        'VITEST_CONFIG_NOT_FOUND',
        `Cannot find the config file "${explicit}" from ${root}`,
      )
    }
    return { kind: 'file', path }
  }
  const path = firstExisting(root, VITEST_CONFIG_CANDIDATES)
  return path === undefined ? undefined : { kind: 'file', path }
}

/**
 * The `vite.config.*` in `root`, if any (what a Vitest project without a `vitest.config.*` uses).
 * @public
 */
export function findViteConfigFile(root: string): ConfigSource | undefined {
  const path = firstExisting(
    root,
    VITEST_CONFIG_CANDIDATES.filter((candidate) => candidate.startsWith('vite.config')),
  )
  return path === undefined ? undefined : { kind: 'file', path }
}

/**
 * The `vitest.workspace.*` file in `root`, if any. Vitest 5.0.5 reads none (workspaces became
 * `test.projects` in Vitest 4), so the reader says so instead of running without it silently.
 * @public
 */
export function findVitestWorkspaceFile(root: string): string | undefined {
  return firstExisting(root, WORKSPACE_CANDIDATES)
}
