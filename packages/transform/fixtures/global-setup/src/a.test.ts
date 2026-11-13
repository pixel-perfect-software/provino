import { appendFileSync } from 'node:fs'
import { label } from './label.ts'

test('runs between the setup and the teardown', () => {
  const seen = (globalThis as Record<string, unknown>).fromGlobalSetup
  const sees = process.env.LOG_SEES === '1' ? ` sees: ${String(seen)}` : ''
  appendFileSync(String(process.env.GLOBAL_SETUP_LOG), `${label('test')}${sees}\n`)
})
