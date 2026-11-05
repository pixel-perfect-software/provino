// The real worker entry, except that the worker kills itself with SIGSEGV when it is told to stop:
// a worker that ends badly while it runs no file. Load it only through the forks transport.
import main from '@provino/orchestrator/worker/main'
import type { WorkerMain } from '@provino/types'

const crashOnStop: WorkerMain = (port) => {
  port.onMessage((message) => {
    if (message.t === 'stop') process.kill(process.pid, 'SIGSEGV')
  })
  return main(port)
}
export default crashOnStop
