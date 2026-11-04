// `connectWorker` against a hand-driven transport: packs reach `onEvents` in order and are acked
// only after it settles, `fileDone` waits for earlier packs, a failing `onEvents` still acks and
// fails the file, and an exit rejects running files only after the packs before it.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  CoordinatorToWorker,
  TaskId,
  Transport,
  WorkerEvent,
  WorkerExit,
  WorkerToCoordinator,
} from '@provino/types'
import { connectWorker } from './connect.ts'

function fakeTransport() {
  const sent: CoordinatorToWorker[] = []
  const listeners: ((message: WorkerToCoordinator) => void)[] = []
  const exitListeners: ((exit: WorkerExit) => void)[] = []
  const transport: Transport = {
    kind: 'inline',
    pid: undefined,
    send: (message) => void sent.push(message),
    onMessage(listener) {
      listeners.push(listener)
      return () => {}
    },
    onExit(listener) {
      exitListeners.push(listener)
      return () => {}
    },
    terminate: async () => {},
  }
  return {
    transport,
    sent,
    receive: (message: WorkerToCoordinator) => {
      for (const listener of listeners) listener(message)
    },
    exit: (exit: WorkerExit) => {
      for (const listener of exitListeners) listener(exit)
    },
  }
}

const methods = {
  resolveSnapshotPath: async (file: string) => file,
  writeSnapshot: async () => {},
  readTimings: async () => undefined,
}
const event = (n: number): WorkerEvent => ({ type: 'test-start', id: `t${n}` as TaskId, t: n })
const job = { file: 'a', fileId: 'file:a' as TaskId, updateSnapshots: 'none' as const }
const fileDone = (seq: number): WorkerToCoordinator => ({
  t: 'fileDone',
  seq,
  memoryBytes: 1,
  leakedHandles: 0,
})

describe('connectWorker', () => {
  it('acks a pack only after onEvents settles, and resolves fileDone after it', async () => {
    const fake = fakeTransport()
    const gate = Promise.withResolvers<void>()
    const seen: number[] = []
    const connection = connectWorker(fake.transport, {
      methods,
      async onEvents(events) {
        await gate.promise
        seen.push(...events.map((e) => (e as { t: number }).t))
      },
    })
    let done = false
    const running = connection.run(job).then((d) => {
      done = true
      return d
    })
    assert.deepEqual(fake.sent, [{ t: 'run', seq: 0, job }])
    fake.receive({ t: 'pack', pack: 0, events: [event(0), event(1)] })
    fake.receive(fileDone(0))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(done, false, 'fileDone waits for the earlier pack')
    assert.equal(fake.sent.length, 1, 'no ack yet')
    gate.resolve()
    assert.deepEqual(await running, fileDone(0))
    assert.deepEqual(seen, [0, 1])
    assert.deepEqual(fake.sent.at(-1), { t: 'ack', pack: 0 })
  })

  it('still acks when onEvents throws, and fails that file with the error', async () => {
    const fake = fakeTransport()
    const boom = new Error('reporter broke')
    const connection = connectWorker(fake.transport, {
      methods,
      onEvents: () => {
        throw boom
      },
    })
    const first = connection.run(job)
    fake.receive({ t: 'pack', pack: 0, events: [event(0)] })
    fake.receive(fileDone(0))
    await assert.rejects(first, boom)
    assert.deepEqual(fake.sent.at(-1), { t: 'ack', pack: 0 })
    const second = connection.run(job)
    fake.receive(fileDone(1))
    assert.equal((await second).seq, 1, 'the failure belongs to one file only')
  })

  it('delivers the packs before an exit, then rejects the running file with it', async () => {
    const fake = fakeTransport()
    const seen: number[] = []
    const connection = connectWorker(fake.transport, {
      methods,
      onEvents: (events) => void seen.push(...events.map((e) => (e as { t: number }).t)),
    })
    const running = connection.run(job)
    fake.receive({ t: 'pack', pack: 0, events: [event(7)] })
    const exit: WorkerExit = { type: 'signal', signal: 'SIGSEGV', likelyOom: false }
    fake.exit(exit)
    await assert.rejects(running, (error: unknown) => {
      assert.deepEqual(seen, [7], 'the last pack was delivered first')
      assert.equal((error as { code?: unknown }).code, 'ORCH_WORKER_EXITED')
      assert.equal((error as Error).cause, exit)
      assert.match((error as Error).message, /killed by SIGSEGV/)
      return true
    })
    assert.equal(await connection.exited, exit)
    await assert.rejects(connection.run(job), { code: 'ORCH_WORKER_EXITED' })
  })

  it('sends cancel with its reason', () => {
    const fake = fakeTransport()
    connectWorker(fake.transport, { methods, onEvents: () => {} }).cancel('bail')
    assert.deepEqual(fake.sent, [{ t: 'cancel', reason: 'bail' }])
  })

  it('hands an onEvents failure with no file running to onError, not to the next file', async () => {
    const fake = fakeTransport()
    const errors: unknown[] = []
    const boom = new Error('reporter broke on a late event')
    let calls = 0
    const connection = connectWorker(fake.transport, {
      methods,
      onEvents: () => {
        if (calls++ === 1) throw boom
      },
      onError: (error) => void errors.push(error),
    })
    const first = connection.run(job)
    fake.receive({ t: 'pack', pack: 0, events: [event(0)] })
    fake.receive(fileDone(0))
    await first
    // A late pack for the finished file, with nothing running.
    fake.receive({ t: 'pack', pack: 1, events: [event(1)] })
    const second = connection.run(job)
    fake.receive(fileDone(1))
    assert.equal((await second).seq, 1)
    assert.deepEqual(errors, [boom])
  })
})
