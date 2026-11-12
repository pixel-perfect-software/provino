// A runner whose one coordinator call can't be sent (a function argument), then finishes.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = (port) =>
  startWorker(port, {
    async runFile({ coordinator }) {
      await coordinator.readTimings((() => 1) as unknown as string).catch(() => {})
      return undefined
    },
  })
export default main
