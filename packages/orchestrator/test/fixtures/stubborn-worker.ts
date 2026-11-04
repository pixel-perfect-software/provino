// A worker that ignores SIGTERM and whose files never finish: only SIGKILL ends it.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

process.on('SIGTERM', () => {})
const main: WorkerMain = (port) => startWorker(port, { runFile: () => new Promise(() => {}) })
export default main
