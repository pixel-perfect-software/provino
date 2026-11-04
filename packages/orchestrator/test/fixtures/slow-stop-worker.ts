// A worker whose `stop` takes real macrotasks (a `setImmediate`, then a file system round trip) and
// that logs when its `start` runs and when its `stop` begins and ends to `globalThis.__steps`, when a
// test has set one (an inline worker shares the test's process).
import { stat } from 'node:fs/promises'
import { setImmediate as macrotask } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

type Logged = typeof globalThis & { __steps?: string[] }

function log(step: string): void {
  ;(globalThis as Logged).__steps?.push(step)
}

const main: WorkerMain = (port) =>
  startWorker(port, {
    start({ init }) {
      log(`start ${init.workerId}`)
    },
    runFile: async () => undefined,
    async stop({ init }) {
      log(`stop ${init.workerId}`)
      await macrotask()
      await stat(fileURLToPath(import.meta.url))
      log(`stopped ${init.workerId}`)
    },
  })
export default main
