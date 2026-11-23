// The shared config of this repo's own suites (B27g2, D193, D194, D203): every migrated package's
// `provino.config.ts` is `export default packageConfig(import.meta.dirname)`. The runner is this
// checkout's built bin, and `defineConfig` comes from the root's `provino: workspace:*` link, so one
// copy of the config types serves every package.
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type ProvinoConfig } from 'provino/config'
import { bootstrapFiles, INCLUDE_GLOBS, SHARED_CONFIG_VALUES } from '../packaging/src/dogfood.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The config of the package at `directory`: its test files, minus the bootstrap set, with
 * `provino-source` resolution, 120 s test and hook timeouts (node:test had none, and CI's job
 * limit is the outer bound; D194) and the shared registry isolation (D193).
 */
export function packageConfig(directory: string): ProvinoConfig {
  return defineConfig({
    include: [...INCLUDE_GLOBS],
    exclude: bootstrapFiles(ROOT).map((file) => relative(directory, join(ROOT, file))),
    isolation: SHARED_CONFIG_VALUES.isolation,
    timeouts: { ...SHARED_CONFIG_VALUES.timeouts },
    resolve: { conditions: [...SHARED_CONFIG_VALUES.conditions] },
  })
}
