// A coordinator, run as its own process: it starts a threads worker and has it segfault. The
// fault is delivered to the whole process, so this process must die by SIGSEGV.
import { connectWorker, threadsTransport } from '@provino/orchestrator'
import type { TaskId } from '@provino/types'

const transport = await threadsTransport({
  entry: new URL('./isolation-worker.ts', import.meta.url),
}).create({
  key: {
    project: 't',
    pool: 'threads',
    environment: 'node',
    environmentOptionsHash: '',
    execArgvHash: '',
    envHash: '',
  },
  workerId: 1,
  isolation: 'registry',
  provided: {},
  config: null,
})
const connection = connectWorker(transport, {
  methods: {
    resolveSnapshotPath: async (file) => file,
    writeSnapshot: async () => {},
    readTimings: async () => undefined,
  },
  onEvents: () => {},
})
await connection.run({
  file: 'segfault',
  fileId: 'file:segfault' as TaskId,
  updateSnapshots: 'none',
})
console.log('survived')
