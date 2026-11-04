// A runner whose one coordinator call can't be sent (a function argument), then finishes.
import { startWorker } from '@provino/orchestrator/worker'
import type { BulkPayload, WorkerMain } from '@provino/types'

const main: WorkerMain = (port) =>
  startWorker(port, {
    async runFile({ coordinator }) {
      await coordinator.writeSnapshot('f', (() => 1) as unknown as BulkPayload).catch(() => {})
      return undefined
    },
  })
export default main
