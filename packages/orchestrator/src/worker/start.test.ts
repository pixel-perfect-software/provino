// `startWorker` over a raw MessageChannel, with the test as the coordinator: what a worker owes the
// coordinator when a runner misbehaves, output arrives late, a cancel comes early, or the
// coordinator goes away. Inline pool, so nothing global is patched.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MessageChannel } from 'node:worker_threads'
import { createRpc, messagePortLink } from '@provino/rpc'
import type {
  CoordinatorMethods,
  CoordinatorToWorker,
  FileJob,
  RuntimeEventOf,
  TaskId,
  WorkerEvent,
  WorkerInit,
  WorkerMethods,
  WorkerPort,
  WorkerToCoordinator,
} from '@provino/types'
import { type StartWorkerOptions, startWorker, type WorkerRunner } from './start.ts'

const init: WorkerInit = {
  key: {
    project: 't',
    pool: 'inline',
    environment: 'node',
    environmentOptionsHash: '',
    execArgvHash: '',
    envHash: '',
  },
  workerId: 1,
  isolation: 'registry',
  provided: {},
  config: null,
}
const job = (file: string): FileJob => ({
  file,
  fileId: `file:${file}` as TaskId,
  updateSnapshots: 'none',
})
const note = (job: FileJob, message: string): WorkerEvent => ({
  type: 'annotation',
  testId: job.fileId,
  message,
  kind: 'note',
  location: null,
  t: 0,
})

/** The test plays the coordinator: it records every message and acks every pack. */
function harness(runner: WorkerRunner, options: StartWorkerOptions = {}) {
  const { port1, port2 } = new MessageChannel()
  const coordinator = messagePortLink<CoordinatorToWorker, WorkerToCoordinator>(port1)
  const workerPort: WorkerPort = messagePortLink(port2)
  const received: WorkerToCoordinator[] = []
  let wake: () => void = () => {}
  coordinator.onMessage((message) => {
    received.push(message)
    if (message.t === 'pack') coordinator.send({ t: 'ack', pack: message.pack })
    wake()
  })
  const done = startWorker(workerPort, runner, options)
  // A round trip to the worker: once it is answered, every message sent before it was handled.
  const worker = createRpc<CoordinatorMethods, WorkerMethods>(coordinator, {
    resolveSnapshotPath: async (file) => file,
    writeSnapshot: async () => {},
    readTimings: async () => undefined,
  })
  const barrier = async (): Promise<void> => {
    await worker.memoryUsage()
  }
  const until = async (match: (message: WorkerToCoordinator) => boolean): Promise<void> => {
    while (!received.some(match)) await new Promise<void>((resolve) => (wake = resolve))
  }
  const events = (): WorkerEvent[] =>
    received.flatMap((message) => (message.t === 'pack' ? message.events : []))
  const fileDone = (seq: number) => (message: WorkerToCoordinator) =>
    message.t === 'fileDone' && message.seq === seq
  return { coordinator, received, done, until, events, fileDone, barrier }
}

describe('startWorker', () => {
  it('still sends fileDone when the thrown value breaks plain serialization', async (t) => {
    const getterError = new Error('x')
    Object.defineProperty(getterError, 'message', {
      get() {
        throw new Error('no message for you')
      },
    })
    const thrown: Record<string, unknown> = {
      'null-prototype': Object.create(null),
      getter: getterError,
    }
    const h = harness({
      runFile: async ({ job }) => {
        throw thrown[job.file]
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('null-prototype') })
    h.coordinator.send({ t: 'run', seq: 1, job: job('getter') })
    await h.until(h.fileDone(1))
    const charged = h
      .events()
      .filter((e): e is RuntimeEventOf<'unhandled-error'> => e.type === 'unhandled-error')
    assert.deepEqual(
      charged.map((e) => e.ownerId),
      ['file:null-prototype', 'file:getter'],
    )
  })

  it('sends output emitted just after runFile returns before fileDone', async (t) => {
    const h = harness({
      runFile: async ({ job, sink }) => {
        sink.emit(note(job, 'during'))
        // A floating chain, as a test's un-awaited promise leaves behind.
        let chain = Promise.resolve()
        for (let i = 0; i < 5; i++) chain = chain.then(() => {})
        void chain.then(() => sink.emit(note(job, 'late')))
        return undefined
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
    await h.until(h.fileDone(0))
    const done = h.received.findIndex(h.fileDone(0))
    const before = h.received
      .slice(0, done)
      .flatMap((m) => (m.t === 'pack' ? m.events : []))
      .map((e) => (e as RuntimeEventOf<'annotation'>).message)
    assert.deepEqual(before, ['during', 'late'])
  })

  it('aborts a file that a cancel reached while it was still queued, but not later ones', async (t) => {
    const starting = Promise.withResolvers<void>()
    const aborted: string[] = []
    const h = harness({
      start: () => starting.promise,
      runFile: async ({ job, signal }) => {
        aborted.push(`${job.file}:${signal.aborted}`)
        return undefined
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('queued') })
    h.coordinator.send({ t: 'cancel', reason: 'bail' })
    h.coordinator.send({ t: 'run', seq: 1, job: job('after') })
    await h.barrier()
    starting.resolve()
    await h.until(h.fileDone(1))
    assert.deepEqual(aborted, ['queued:true', 'after:false'])
  })

  it('never starts files still queued when the coordinator goes away', async (t) => {
    const first = Promise.withResolvers<void>()
    const running = Promise.withResolvers<void>()
    const started: string[] = []
    const h = harness({
      runFile: async ({ job }) => {
        started.push(job.file)
        running.resolve()
        await first.promise
        return undefined
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
    h.coordinator.send({ t: 'run', seq: 1, job: job('b') })
    await running.promise
    await h.barrier()
    h.coordinator.close()
    await h.done
    first.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(started, ['a'])
  })

  it('gives each file a fresh console: no open group or count carries over', async (t) => {
    const h = harness({
      runFile: async ({ job, console }) => {
        if (job.file === 'one') {
          console.group('suite')
          console.count('hits')
        } else {
          console.log('two')
          console.count('hits')
        }
        return undefined
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('one') })
    h.coordinator.send({ t: 'run', seq: 1, job: job('two') })
    await h.until(h.fileDone(1))
    const texts = h
      .events()
      .filter((e): e is RuntimeEventOf<'console'> => e.type === 'console')
      .map((e) => e.text)
    assert.deepEqual(texts, ['suite\n', '  hits: 1\n', 'two\n', 'hits: 1\n'])
  })
})
