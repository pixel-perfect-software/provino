// The shared config of this repo's own suites (B27g2, D193, D194, D203): every migrated package's
// `provino.config.ts` is `export default packageConfig(import.meta.dirname)`. The runner is this
// checkout's built bin (`packages/provino/dist/cli.js`), and `defineConfig` comes from the root's
// `provino: workspace:*` link, so one copy of the config types serves every package.
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type ProvinoConfig } from 'provino/config'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** What `bootstrap.json` holds: the files that stay on node:test, each with the reason. */
interface Bootstrap {
  readonly files: Readonly<Record<string, string>>
}

/**
 * The repo-relative paths of the files that stay on `node:test` (`tooling/provino/bootstrap.json`).
 * @internal
 */
export function bootstrapFiles(): readonly string[] {
  const parsed = JSON.parse(
    readFileSync(join(ROOT, 'tooling/provino/bootstrap.json'), 'utf8'),
  ) as Bootstrap
  return Object.keys(parsed.files)
}

/**
 * The config of the package at `directory`: its test files under `src`, `test` and `bench`, minus the
 * bootstrap set, with `provino-source` resolution, 120 s test and hook timeouts (node:test had none,
 * and CI's job limit is the outer bound; D194) and the shared registry isolation (D193).
 * @internal
 */
export function packageConfig(directory: string): ProvinoConfig {
  return defineConfig({
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.test.ts'],
    exclude: bootstrapFiles().map((file) => relative(directory, join(ROOT, file))),
    isolation: 'registry',
    timeouts: { test: 120_000, hook: 120_000 },
    resolve: { conditions: ['provino-source'] },
  })
}
