import { appendFileSync } from 'node:fs'
import { label } from './src/label.ts'

export default async function teardown(): Promise<void> {
  const log = process.env.GLOBAL_SETUP_LOG
  if (log === undefined) throw new Error('GLOBAL_SETUP_LOG is not set')
  const seen = (globalThis as Record<string, unknown>).fromGlobalSetup
  appendFileSync(
    log,
    `${label('teardown')}${process.env.LOG_SEES === '1' ? ` sees: ${String(seen)}` : ''}\n`,
  )
}
