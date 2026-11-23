import type { ProvinoConfig } from 'provino/config'
import { packageConfig } from '../../tooling/provino/base.ts'

const config: ProvinoConfig = packageConfig(import.meta.dirname)

export default config
