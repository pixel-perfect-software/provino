// A global setup in TypeScript, with an import and an export default: what a transformer turns
// into CommonJS with `__esModule` set. It logs what it was called with to the file the test names.
import { appendFileSync } from 'node:fs'
import { label } from './src/label.ts'

interface GlobalConfig {
  readonly rootDir: string
}
interface ProjectConfig {
  readonly rootDir: string
}

export default async function setup(
  globalConfig: GlobalConfig,
  projectConfig: ProjectConfig,
): Promise<void> {
  const log = process.env.GLOBAL_SETUP_LOG
  if (log === undefined) {
    throw new Error('GLOBAL_SETUP_LOG is not set')
  }
  // What a global setup does to the process's global: a test in a worker doesn't see it, one in
  // band does (jest-environment-node copies the main process's globals), the teardown always does.
  const outer = globalThis as Record<string, unknown>
  outer.fromGlobalSetup = 'set by the setup'
  const same = globalConfig.rootDir === projectConfig.rootDir ? 'same' : 'other'
  appendFileSync(log, `${label('setup')} global=${same}\n`)
}
