// Track 9 spike A2's isolation cases, one per job: what a test file does to its worker. A case
// that leaves the worker alive reports its observation as an annotation.
import { writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

/** Writes all of `text` to `fd` before returning, as V8 does for its fatal error before it aborts. */
function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text)
  let written = 0
  while (written < bytes.length) {
    try {
      written += writeSync(fd, bytes, written)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EAGAIN') throw error
    }
  }
}

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
        case 'abort':
          // An abort that is not a heap OOM: no fatal error line from V8.
          process.kill(process.pid, 'SIGABRT')
          return await new Promise(() => {})
        case 'oom': {
          const hold: unknown[] = []
          for (;;) hold.push(new Array(100_000).fill({ hold }))
        }
        case 'oom-then-noise':
          // What V8 does on a real heap OOM: the fatal error, then about 8 KB of native stack,
          // then the abort. The line ends up further from the end of stderr than any fixed tail.
          writeAllSync(
            2,
            `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n${'----- Native stack trace -----\n'.repeat(400)}`,
          )
          process.abort()
          return await new Promise(() => {})
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
