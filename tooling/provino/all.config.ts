// Every migrated package in one call: `pnpm build && pnpm test:provino` (B27g2; the build is
// for the built-output tests of `BUILT_TEST_DEPENDS_ON`'s packages; see `dogfood.ts`, D206). The projects are
// the directories with a `provino.config.ts` of their own, each listed inline from the same
// `packageProject` its own config uses: a project that sets `execArgv` is refused
// (`CONFIG_UNKNOWN_KEY`), so the run's values (`runValues`) are set once, here. This file is not at the
// root: a root config would be found by every in-repo discovery (D196, D200), including the tests
// that expect none.
// It runs the Provino half only: each package's bootstrap files (`tooling/provino/bootstrap.json`)
// stay on node:test and run in the package's own `test` script, so a green `pnpm test:provino` is
// not the whole suite.
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type ProvinoConfig } from 'provino-runner/config'
import { migratedDirs } from '../packaging/src/dogfood.ts'
import { packageProject, runValues } from './base.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dirs = migratedDirs(ROOT)
if (dirs.length === 0) throw new Error(`no migrated package (a provino.config.ts) under ${ROOT}`)

const config: ProvinoConfig = defineConfig({
  root: '../..',
  projects: dirs.map((dir) => ({
    name: basename(dir),
    root: `../../${dir}`,
    ...packageProject(resolve(ROOT, dir)),
  })),
  ...runValues(),
})

export default config
