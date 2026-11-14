// The coordinator of `watch-session.test.ts`, as a process of its own: a watch session over the
// project, driven by the steps in `WATCH_STEPS` (JSON), then closed. The changes come through the
// session's change source, fed here after each real edit on disk, and its coalescing window is a
// clock this script fires itself, so nothing waits on time. What each run reported is written to
// the output file as JSON; the test starts this in a process group of its own and sweeps it after.
//
// Arguments: the project directory, the pool kind, the output file.
import { writeFileSync } from 'node:fs'
import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type CoalesceClock, createWatchSession, type WatchEvent } from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { FileFilter, PoolKind, Reporter } from '@provino/types'
import { PID_RECORDING_ENTRY, runtimeProject } from '../support.ts'

/** One step of the script. */
type Step =
  | {
      readonly do: 'run'
      readonly fileFilters?: readonly FileFilter[]
      readonly interruptAt?: string
    }
  | { readonly do: 'write'; readonly path: string; readonly text: string }
  | { readonly do: 'unlink'; readonly path: string }
  | { readonly do: 'flush' }

/** What one run reported. */
interface RunReport {
  readonly reason: string
  /** Each file's state, by its path. */
  readonly files: Record<string, string>
  /** The worker that took each file. */
  readonly workers: Record<string, number>
  /** Each failed file's error messages. */
  readonly errors: Record<string, readonly string[]>
}

const [dir, kind, out] = process.argv.slice(2) as [string, PoolKind, string]
const steps = JSON.parse(process.env.WATCH_STEPS ?? '[]') as readonly Step[]

let timers: (() => void)[] = []
const clock: CoalesceClock = {
  schedule(callback) {
    timers.push(callback)
    return () => {
      timers = timers.filter((timer) => timer !== callback)
    }
  },
}
let sink: { readonly event: (event: WatchEvent) => void } | undefined

const session = await createWatchSession([runtimeProject(dir)], {
  cache: false,
  ...(kind === 'forks' ? { entry: PID_RECORDING_ENTRY } : {}),
  pool: { kind, maxWorkers: 1 },
  clock,
  changes: (given) => {
    sink = given
    return { close: () => {} }
  },
})

const reports: RunReport[] = []
const batches: (readonly WatchEvent[])[] = []
session.onChange((batch) => batches.push(batch))
try {
  for (const step of steps) {
    const path = 'path' in step ? join(dir, step.path) : ''
    switch (step.do) {
      case 'write': {
        const existed = await stat(path).then(
          () => true,
          () => false,
        )
        await writeFile(path, step.text)
        const { mtimeMs } = await stat(path)
        sink?.event({ kind: existed ? 'change' : 'add', path, mtimeMs })
        break
      }
      case 'unlink':
        await rm(path)
        sink?.event({ kind: 'unlink', path, mtimeMs: undefined })
        break
      case 'flush': {
        const due = timers
        timers = []
        for (const timer of due) timer()
        break
      }
      case 'run': {
        const report: RunReport = { reason: '', files: {}, workers: {}, errors: {} }
        const reporter: Reporter = {
          name: 'watch-coordinator',
          'file:start': (file, workerId) => {
            report.workers[file.path] = workerId
          },
          'task:start': (task) => {
            // The explicit signal an interrupt waits for: the test named has started.
            if (task.name === step.interruptAt) session.interrupt()
          },
          'file:end': (result) => {
            report.files[result.file.path] = result.state
            if (result.errors.length > 0) {
              report.errors[result.file.path] = result.errors.map((error) => error.message)
            }
          },
        }
        const summary = await session.run({
          bus: createReporterBus([reporter]),
          ...(step.fileFilters === undefined ? {} : { fileFilters: step.fileFilters }),
        })
        reports.push({ ...report, reason: summary.reason })
        break
      }
      default:
        step satisfies never
    }
  }
} finally {
  await session.close()
}

writeFileSync(
  out,
  JSON.stringify({
    reports,
    batches: batches.map((batch) => batch.map((event) => `${event.kind} ${event.path}`)),
  }),
)
// Nothing of the session may hold the process open: it ends by itself, or the test's deadline fails.
