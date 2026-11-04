// A runner that throws must not stall the worker: the error is charged to the file as an
// unhandled error, and `fileDone` still comes. The logic is the same for every kind, so inline
// covers it.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectWorker } from '@provino/orchestrator'
import type { RuntimeEventOf, WorkerEvent } from '@provino/types'
import { factoryFor, fixture, initFor, job } from './support.ts'

async function connect(workerId: number) {
  const transport = await factoryFor('inline', { entry: fixture('failing-worker.ts') }).create(
    initFor('inline', workerId),
  )
  const events: WorkerEvent[] = []
  const connection = connectWorker(transport, {
    methods: {
      resolveSnapshotPath: async (file) => file,
      writeSnapshot: async () => {},
      readTimings: async () => undefined,
    },
    onEvents: (batch) => void events.push(...batch),
  })
  return { transport, connection, events }
}

const unhandled = (events: readonly WorkerEvent[]) =>
  events.filter((e): e is RuntimeEventOf<'unhandled-error'> => e.type === 'unhandled-error')

describe('a runner that throws', () => {
  it('charges a runFile error to the file and still sends fileDone', async () => {
    const { transport, connection, events } = await connect(1)
    await connection.run(job('throws'))
    await connection.run(job('fine'))
    await transport.terminate(false)
    const errors = unhandled(events)
    assert.equal(errors.length, 1)
    assert.equal(errors[0]?.ownerId, 'file:throws')
    assert.equal(errors[0]?.error.name, 'TypeError')
    assert.equal(errors[0]?.error.message, 'runner bug')
  })

  it('charges a failed start to every file, and keeps answering', async () => {
    const { transport, connection, events } = await connect(2)
    const done = [await connection.run(job('a')), await connection.run(job('b'))]
    assert.deepEqual(
      done.map((d) => d.seq),
      [0, 1],
    )
    await transport.terminate(false)
    assert.deepEqual(await connection.exited, { type: 'exit', code: 0 })
    assert.deepEqual(
      unhandled(events).map((e) => [e.ownerId, e.error.message]),
      [
        ['file:a', 'setup failed'],
        ['file:b', 'setup failed'],
      ],
    )
  })
})
