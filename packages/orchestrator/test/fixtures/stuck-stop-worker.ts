// A worker that runs its files and then cannot be stopped: its teardown never ends and it ignores
// SIGTERM, so only SIGKILL gets rid of it (a graceful stop that waits out the teardown timeout).
// Like `pid-recording-main.ts` it notes its pid (`takeWorkerPids` in `test/support.ts`), so a test
// can check afterwards that the kill reached it: load it only through the forks transport.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'
import { recordPid } from './record-pid.ts'

recordPid()
process.on('SIGTERM', () => {})
const main: WorkerMain = (port) =>
  startWorker(port, {
    runFile: async () => undefined,
    stop: () => new Promise(() => {}),
  })
export default main
