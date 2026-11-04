// A worker whose files never finish, so a `stop` queued behind one is never handled.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = (port) => startWorker(port, { runFile: () => new Promise(() => {}) })
export default main
