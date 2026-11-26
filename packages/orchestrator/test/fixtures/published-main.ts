// The real worker entry, whose run a test can wait on: each call's promise (it settles once the
// worker has stopped, a best-effort stop after a kill included) goes on `globalThis.__workerMains`
// when a test has set that array. Inline only: it shares the test's global.
import main from '@provino/orchestrator/worker/main'
import type { WorkerMain } from '@provino/types'

type Published = typeof globalThis & { __workerMains?: Promise<void>[] }

const published: WorkerMain = (port) => {
  const settled = main(port)
  ;(globalThis as Published).__workerMains?.push(settled)
  return settled
}
export default published
