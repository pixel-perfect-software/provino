// Every migrated package in one call: `pnpm build && pnpm test:provino` (B27g2). The projects are the
// directories with a `provino.config.ts` of their own. This file is not at the root: a root config
// would be found by every in-repo discovery (D196, D200), including the tests that expect none.
import { defineConfig, type ProvinoConfig } from 'provino/config'
import { migratedDirs } from '../packaging/src/dogfood.ts'

const config: ProvinoConfig = defineConfig({ root: '../..', projects: [...migratedDirs('.')] })

export default config
