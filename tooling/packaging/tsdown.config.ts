// The tsdown config of every package but `provino`: each package's `build` script points here
// (`tsdown --config ../../tooling/packaging/tsdown.config.ts`) and the build runs in the package's
// directory, so this reads that directory's package.json. See `src/preset.ts`.
import { defineConfig, type UserConfigExport } from 'tsdown/config'
import { packageConfig } from './src/preset.ts'

const config: UserConfigExport = defineConfig(() => packageConfig(process.cwd()))

export default config
