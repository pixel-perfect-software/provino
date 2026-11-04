// A runner that fails: `start` throws for worker 2, and `runFile` throws for the job `throws`.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = (port) =>
  startWorker(port, {
    start({ init }) {
      if (init.workerId === 2) throw new Error('setup failed')
    },
    async runFile({ job }) {
      if (job.file === 'throws') throw new TypeError('runner bug')
      return undefined
    },
  })
export default main
