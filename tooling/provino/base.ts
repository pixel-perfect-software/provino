// The shared config of this repo's own suites (B27g2, D193, D194, D191): every migrated package's
// `provino.config.ts` is `packageConfig(import.meta.dirname)`. The runner is the pinned rc
// (`provino-runner`, D191), and `defineConfig` comes from its `provino-runner/config`, so one copy of
// the config types serves every package.
//
// The config has two parts because a project may not set the run's keys (`execArgv`, `maxWorkers`:
// `CONFIG_UNKNOWN_KEY`): `packageProject` is what a project holds, `runValues` what only a top-level
// config holds. A package's own config is both; `all.config.ts` (`pnpm test:provino`) lists each
// package's `packageProject` as an inline project and sets `runValues` once at its own top level.
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig, type ProvinoConfig } from 'provino-runner/config'
import {
  bootstrapFiles,
  CONDITIONS_FLAG,
  INCLUDE_GLOBS,
  SHARED_CONFIG_VALUES,
} from '../packaging/src/dogfood.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * What a project of this repo's suites holds, for the package at `directory`: its test files,
 * minus the bootstrap set, with `provino-source` resolution, 120 s test and hook timeouts
 * (node:test had none, and CI's job limit is the outer bound; D194) and the shared registry
 * isolation (D193). The paths are relative to `directory`, the project's root.
 */
export function packageProject(directory: string): {
  include: string[]
  exclude: string[]
  isolation: 'registry'
  timeouts: { test: number; hook: number }
  resolve: { conditions: string[] }
} {
  return {
    include: [...INCLUDE_GLOBS],
    exclude: bootstrapFiles(ROOT).map((file) => relative(directory, join(ROOT, file))),
    // A copy: a config's nested objects are the run's to read, never a shared constant.
    ...structuredClone(SHARED_CONFIG_VALUES),
  }
}

/**
 * What only a run's top-level config holds. `execArgv` gives the workers `provino-source` for
 * Node's own resolver too (D206), as the tests' own process had: a test that resolves a package
 * (`createRequire(import.meta.url).resolve(…)`) and a nested fork both load source, not `dist`.
 */
export function runValues(): { execArgv: string[]; maxWorkers?: number } {
  return {
    execArgv: [CONDITIONS_FLAG],
    // CI runs many packages at once through Turborepo; two workers each keeps the runner from being oversubscribed.
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
  }
}

/** The config of the package at `directory`: its project and the run's values. */
export function packageConfig(directory: string): ProvinoConfig {
  return defineConfig({ ...packageProject(directory), ...runValues() })
}
