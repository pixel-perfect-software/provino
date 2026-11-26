// Every migrated package in one call: `pnpm build && pnpm test:provino` (B27g2; the build is
// `TEST_BUILD`'s, in `dogfood.ts`). The projects are the directories with a `provino.config.ts` of
// their own. This file is not at the root: a root config
// would be found by every in-repo discovery (D196, D200), including the tests that expect none.
// It runs the Provino half only: each package's bootstrap files (`tooling/provino/bootstrap.json`)
// stay on node:test and run in the package's own `test` script, so a green `pnpm test:provino` is
// not the whole suite.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type ProvinoConfig } from 'provino-runner/config'
import { migratedDirs } from '../packaging/src/dogfood.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const projects = migratedDirs(ROOT)
if (projects.length === 0)
  throw new Error(`no migrated package (a provino.config.ts) under ${ROOT}`)

const config: ProvinoConfig = defineConfig({ root: '../..', projects: [...projects] })

export default config
