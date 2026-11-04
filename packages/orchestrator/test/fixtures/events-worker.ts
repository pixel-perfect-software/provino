// A fake runner for T9.4's loss check. Job `events:<count>:<seed>` emits `count` events of mixed
// types, each numbered in its id or text, with seeded gaps (microtasks, macrotasks, timers) and
// bursts long enough to cut 64-event packs inside one macrotask.
import { startWorker } from '@provino/orchestrator/worker'
import type { TaskId, WorkerEvent, WorkerMain } from '@provino/types'
import { gap, int, pick, seeded } from './random.ts'

export function eventFor(n: number): WorkerEvent {
  const id = `e${n}` as TaskId
  switch (n % 4) {
    case 0:
      return { type: 'test-start', id, t: n }
    case 1:
      return { type: 'suite-start', id, t: n }
    case 2:
      return { type: 'annotation', testId: id, message: `m${n}`, kind: 'k', location: null, t: n }
    default:
      return {
        type: 'console',
        taskId: id,
        stream: 'stdout',
        level: 'log',
        text: `c${n}\n`,
        origin: null,
        t: n,
      }
  }
}

/** The number an event carries, whatever its type. */
export function numberOf(event: WorkerEvent): number {
  const id =
    'id' in event
      ? event.id
      : 'testId' in event
        ? event.testId
        : 'taskId' in event
          ? event.taskId
          : null
  return Number(String(id).slice(1))
}

const main: WorkerMain = (port) =>
  startWorker(port, {
    async runFile({ job, sink }) {
      const [, count, seed] = job.file.split(':').map(Number)
      const random = seeded(seed ?? 0)
      let n = 0
      while (n < (count ?? 0)) {
        const burst = random() < 0.2 ? int(random, 64, 300) : int(random, 1, 40)
        for (let i = 0; i < burst && n < (count ?? 0); i++) sink.emit(eventFor(n++))
        await gap(pick(random, ['microtask', 'immediate', 'immediate', 'timeout'] as const))
      }
      return undefined
    },
  })
export default main
