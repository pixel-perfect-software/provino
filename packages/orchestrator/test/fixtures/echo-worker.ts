// A worker that runs nothing: each `run` gets its `fileDone` straight away.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = (port) => startWorker(port, { runFile: async () => undefined })
export default main
