// The program worker for forks and threads: the capture owns the process's console and streams.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'
import { programWorker } from './program-runner.ts'

const { runner, options } = programWorker(
  () => ({ stdout: process.stdout, stderr: process.stderr }),
  'global',
)
const main: WorkerMain = (port) => startWorker(port, runner, options)
export default main
