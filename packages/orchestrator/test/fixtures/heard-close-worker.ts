// A worker whose files never finish, and that counts on the global each time its end of the link
// hears the link close (`globalThis.__heardClose`). Inline only: it shares the test's global.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

type Noted = typeof globalThis & { __heardClose?: number }

const main: WorkerMain = (port) => {
  port.onExit(() => {
    const noted = globalThis as Noted
    noted.__heardClose = (noted.__heardClose ?? 0) + 1
  })
  return startWorker(port, { runFile: () => new Promise(() => {}) })
}
export default main
