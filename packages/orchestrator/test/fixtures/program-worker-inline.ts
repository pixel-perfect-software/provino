// The program worker for inline runs: it shares the test process, so the program writes through
// the capture's console and to stand-in streams, never to the real ones.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'
import { programWorker } from './program-runner.ts'

const stand = (): { write(chunk: unknown, ...rest: unknown[]): boolean } => ({
  write(_chunk, ...rest) {
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined
    callback?.()
    return true
  },
})
const streams = { stdout: stand(), stderr: stand() }
const { runner, options } = programWorker(() => streams, 'context')
const main: WorkerMain = (port) =>
  startWorker(port, runner, { ...options, console: { ...options.console, streams } })
export default main
