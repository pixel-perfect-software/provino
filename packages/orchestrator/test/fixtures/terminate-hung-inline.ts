// Run as its own process by transport.test.ts: an inline worker stuck in a file holds no handle,
// so nothing but the transport's bound keeps this process alive while `terminate` waits.

import { connectWorker } from '@provino/orchestrator'
import { Collect, factoryFor, fixture, initFor, job, methods } from '../support.ts'

const transport = await factoryFor('inline', {
  entry: fixture('hang-worker.ts'),
  stderr: new Collect(),
  teardownTimeoutMs: 50,
}).create(initFor('inline'))
const connection = connectWorker(transport, { methods, onEvents: () => {} })
void connection.run(job('forever')).catch(() => {})
await transport.terminate(true)
console.log('terminated', JSON.stringify(await connection.exited))
