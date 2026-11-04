// A worker that writes to its real stdout and stderr before the capture is installed, so the
// writes travel through the transport's stdio pipes.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = (port) => {
  process.stdout.write('raw stdout before start\n')
  process.stderr.write('raw stderr before start\n')
  return startWorker(port, { runFile: async () => undefined })
}
export default main
