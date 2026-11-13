// The tsdown config of the `provino` package (its `build` script points here). It is built from
// the package's directory: see `src/umbrella.ts` for what is inlined and what stays external.
import { defineConfig, type UserConfigExport } from 'tsdown/config'
import { umbrellaConfig } from './src/umbrella.ts'

const config: UserConfigExport = defineConfig(() => umbrellaConfig(process.cwd()))

export default config
