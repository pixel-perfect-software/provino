// A runner that leaves a floating promise behind: it emits once more a few microtasks after
// `runFile` has returned, as an un-awaited `.then` in a test file would.
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = (port) =>
  startWorker(port, {
    async runFile({ job, sink }) {
      const note = (message: string) =>
        sink.emit({
          type: 'annotation',
          testId: job.fileId,
          message,
          kind: 'k',
          location: null,
          t: 0,
        })
      note('during')
      let chain = Promise.resolve()
      for (let i = 0; i < 5; i++) chain = chain.then(() => {})
      void chain.then(() => note('late'))
      return undefined
    },
  })
export default main
