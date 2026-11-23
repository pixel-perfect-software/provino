import type { ProvinoConfig } from 'provino/config'
import { packageConfig } from '../../tooling/provino/base.ts'

const base: ProvinoConfig = packageConfig(import.meta.dirname)
if (typeof base === 'function') throw new TypeError('the shared config is an object')

const config: ProvinoConfig = {
  ...base,
  // A whole-repo or whole-corpus test that had no timeout under node:test; 120 s is too tight on a loaded CI runner.
  timeouts: { ...base.timeouts, test: 600_000 },
}

export default config
