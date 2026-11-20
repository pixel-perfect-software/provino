// @provino/dialect-vitest/node: the Vitest dialect's coordinator half. B25c (T11.15) built the config
// reader without Vite: find (`vitest.config.*` then `vite.config.*` in the root), load (native
// import, `vitest/config` served by a stand-in, a plugins list marks `needsVite` for B25d's bridge),
// resolve (`test` over Vitest's defaults, the command line over the file, `test.projects`, mode and
// `.env*`) and the neutral projects. `vitestNodeDialect` is `vitestDialect` plus the reader; the
// command line comes with B25g.

import { resolve as resolvePath } from 'node:path'
import { vitestDialect } from '@provino/dialect-vitest'
import type {
  ConfigReader,
  ConfigSource,
  Diagnostic,
  Dialect,
  NeutralProject,
} from '@provino/types'
import {
  findViteConfigFile,
  findVitestConfig,
  findVitestWorkspaceFile,
  VITEST_CONFIG_CANDIDATES,
} from './find.ts'
import { loadVitestConfig, type VitestLoadedConfig } from './load.ts'
import {
  resolveVitestProjects,
  type VitestReadOptions,
  type VitestResolvedConfig,
} from './normalize.ts'
import { vitestProjectToNeutral } from './to-neutral.ts'

export { expandDotenv, loadVitestEnv, parseDotenv } from './env.ts'
export { VitestConfigError, type VitestConfigErrorCode } from './errors.ts'
export {
  findViteConfigFile,
  findVitestConfig,
  findVitestWorkspaceFile,
  VITEST_CONFIG_CANDIDATES,
} from './find.ts'
export { expandGlobs, globToRegexSource } from './glob.ts'
export { loadVitestConfig, type VitestLoadedConfig } from './load.ts'
export {
  resolveVitestProjects,
  type VitestReadOptions,
  type VitestResolvedConfig,
  type VitestResolvedProject,
} from './normalize.ts'
export { vitestProjectToNeutral } from './to-neutral.ts'
export { mergeAlias, mergeConfig, normalizeAlias } from './vite-merge.ts'
export {
  configDefaults as vitestConfigDefaults,
  coverageConfigDefaults as vitestCoverageConfigDefaults,
  vitestConfigStandIn,
} from './vitest-config-stand-in.ts'

/**
 * What the reader's `load` step returns: the loaded file, or `undefined` when the root has none
 * (Vitest then runs on its defaults).
 * @public
 */
export type VitestRawConfig = VitestLoadedConfig | undefined

/**
 * The Vitest config reader for a working directory and the command line's options.
 * @public
 */
export function createVitestConfigReader(
  options: VitestReadOptions = {},
): ConfigReader<VitestRawConfig, VitestResolvedConfig> {
  const rootOf = (cwd: string): string =>
    options.root === undefined ? cwd : resolvePath(cwd, options.root)
  return {
    candidates: VITEST_CONFIG_CANDIDATES,
    async find(cwd: string, explicit?: string): Promise<ConfigSource | undefined> {
      return findVitestConfig(rootOf(options.cwd ?? cwd), explicit ?? options.config)
    },
    load(source: ConfigSource): Promise<VitestRawConfig> {
      return loadVitestConfig(source, { mode: options.mode ?? 'test' })
    },
    async resolve(raw: VitestRawConfig, _source: ConfigSource) {
      const diagnostics: Diagnostic[] = []
      const root = rootOf(options.cwd ?? process.cwd())
      const workspace = findVitestWorkspaceFile(root)
      if (workspace !== undefined) {
        diagnostics.push({
          level: 'warning',
          code: 'VITEST_WORKSPACE_FILE_IGNORED',
          message: `${workspace} is not read: Vitest 4 and later ignore vitest.workspace files; list the projects in test.projects`,
        })
      }
      const value = await resolveVitestProjects(raw, {
        ...options,
        cwd: options.cwd ?? process.cwd(),
      })
      return { value, diagnostics }
    },
    toNeutral(resolved: VitestResolvedConfig) {
      const diagnostics: Diagnostic[] = []
      const value: NeutralProject[] = resolved.projects.map((project) => {
        const neutral = vitestProjectToNeutral(project)
        diagnostics.push(...neutral.diagnostics)
        return neutral.project
      })
      return { value, diagnostics }
    },
  }
}

/**
 * Reads a project directory end to end: find, load, resolve, neutral projects. With no config file
 * in the root it runs on Vitest's defaults (the reader's `find` says `undefined` for that, which the
 * step-by-step interface can't hand on).
 * @public
 */
export async function readVitestConfig(options: VitestReadOptions = {}): Promise<{
  readonly projects: readonly NeutralProject[]
  readonly diagnostics: readonly Diagnostic[]
  readonly needsVite: boolean
}> {
  const reader = createVitestConfigReader(options)
  const cwd = options.cwd ?? process.cwd()
  const source = await reader.find(cwd)
  const raw = source === undefined ? undefined : await reader.load(source)
  const resolved = await reader.resolve(raw, source ?? { kind: 'file', path: cwd })
  const neutral = reader.toNeutral(resolved.value)
  return {
    projects: neutral.value,
    diagnostics: [...resolved.diagnostics, ...neutral.diagnostics],
    needsVite: resolved.value.projects.some((project) => project.needsVite),
  }
}

/**
 * The Vitest config reader with the defaults: the process's working directory and no command line.
 * @public
 */
export const vitestConfigReader: ConfigReader<VitestRawConfig, VitestResolvedConfig> =
  createVitestConfigReader()

/**
 * Whether `root` holds a `vite.config.*` whose export has a `test` key: a Vitest project that
 * has no `vitest.config.*` (T11.13's detection). It imports the file, never Vite.
 * @public
 */
export async function viteConfigDeclaresTests(root: string): Promise<boolean> {
  const found = findViteConfigFile(root)
  if (found === undefined) return false
  const loaded = await loadVitestConfig(found, { mode: 'test' })
  return 'test' in loaded.config
}

/**
 * The Vitest 5.0 dialect with its config reader: what the coordinator uses. `vitestDialect` (`.`)
 * is the same value without it, for code that runs in a worker.
 * @public
 */
export const vitestNodeDialect: Dialect<'vitest'> = {
  ...vitestDialect,
  configReader: vitestConfigReader,
}
