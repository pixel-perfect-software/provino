// The runner both program workers share. Job `program:<seed>` runs that seed's program.
import type { StartWorkerOptions, WorkerRunner } from '@provino/orchestrator/worker'
import type { TaskId } from '@provino/types'
import { program, run } from './program.ts'

export function programWorker(
  streams: () => {
    readonly stdout: { write(text: string): unknown }
    readonly stderr: { write(text: string): unknown }
  },
  console: 'global' | 'context',
): { runner: WorkerRunner; options: StartWorkerOptions } {
  let current: TaskId | null = null
  return {
    options: { console: { currentTaskId: () => current } },
    runner: {
      async runFile({ job, sink, console: captured }) {
        const seed = Number(job.file.split(':')[1])
        await run(program(seed), {
          emit: (event) => sink.emit(event),
          console: console === 'global' ? globalThis.console : captured,
          streams: streams(),
          setTask: (id) => {
            current = id
          },
        })
        return undefined
      },
    },
  }
}
