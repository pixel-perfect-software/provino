// Track 9 spike A2's isolation cases, one per job: what a test file does to its worker. A case
// that leaves the worker alive reports its observation as an annotation.
import { tmpdir } from 'node:os'
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = (port) =>
  startWorker(port, {
    async runFile({ job, sink }) {
      const report = (message: string): void =>
        sink.emit({
          type: 'annotation',
          testId: job.fileId,
          message,
          kind: job.file,
          location: null,
          t: performance.now(),
        })
      switch (job.file) {
        case 'segfault':
          // What a crashing native addon delivers.
          process.kill(process.pid, 'SIGSEGV')
          return await new Promise(() => {})
        case 'oom': {
          const hold: unknown[] = []
          for (;;) hold.push(new Array(100_000).fill({ hold }))
        }
        case 'exit3':
          process.exit(3)
          break
        case 'chdir':
          try {
            process.chdir(tmpdir())
            report('ok')
          } catch (error) {
            report(String((error as { code?: unknown }).code))
          }
          return undefined
        case 'tz':
          process.env.TZ = 'Asia/Tokyo'
          report(String(new Date(0).getHours()))
          return undefined
        default:
          throw new Error(`unknown case ${job.file}`)
      }
    },
  })
export default main
