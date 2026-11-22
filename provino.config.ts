// Every package that runs on Provino, in one call: `pnpm build && pnpm test:provino` (B27g2). Turborepo's
// per-package `test` runs each package's own `provino.config.ts`; a package joins both when it migrates.
import { defineConfig } from 'provino/config'

export default defineConfig({ projects: ['packages/policy', 'packages/lazy'] })
