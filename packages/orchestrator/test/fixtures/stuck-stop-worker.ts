// A worker that runs its files and then cannot be stopped: its teardown never ends and it ignores
// SIGTERM, so only SIGKILL gets rid of it (a graceful stop that waits out the teardown timeout).
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

process.on('SIGTERM', () => {})
const main: WorkerMain = (port) =>
  startWorker(port, {
    runFile: async () => undefined,
    stop: () => new Promise(() => {}),
  })
export default main
