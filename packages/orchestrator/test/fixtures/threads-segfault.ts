// A coordinator, run as its own process: it starts a threads worker and has it segfault. The
// fault is delivered to the whole process, so this process must die by SIGSEGV.
import { connectWorker, threadsTransport } from '@provino/orchestrator'
import { initFor, job, methods } from '../support.ts'

const transport = await threadsTransport({
  entry: new URL('./isolation-worker.ts', import.meta.url),
}).create(initFor('threads'))
const connection = connectWorker(transport, { methods, onEvents: () => {} })
await connection.run(job('segfault'))
console.log('survived')
