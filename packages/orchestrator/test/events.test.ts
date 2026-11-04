// T9.4's first check: a fake runner emitting 10k events loses none under forks and threads (and
// inline), while the coordinator handles packs slowly, so the 8-pack window is what holds the
// worker back. Every event arrives once, in order, before the file's `fileDone`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectWorker } from '@provino/orchestrator'
import type { CoordinatorToWorker, Transport, WorkerEvent } from '@provino/types'
import { numberOf } from './fixtures/events-worker.ts'
import { gap, int, seeded } from './fixtures/random.ts'
import { factoryFor, fixture, initFor, job, KINDS } from './support.ts'

const COUNT = 10_000

for (const kind of KINDS) {
  describe(`${kind}: 10k events`, () => {
    it('arrive once, in order, before fileDone, with at most 8 packs unacked', async () => {
      const raw = await factoryFor(kind, { entry: fixture('events-worker.ts') }).create(
        initFor(kind),
      )
      let packsArrived = 0
      let acksSent = 0
      let mostUnacked = 0
      raw.onMessage((message) => {
        if (message.t !== 'pack') return
        packsArrived++
        mostUnacked = Math.max(mostUnacked, packsArrived - acksSent)
      })
      // Count the acks on their way out.
      const transport: Transport = {
        ...raw,
        send(message: CoordinatorToWorker, transfer?: readonly ArrayBuffer[]) {
          if (message.t === 'ack') acksSent++
          raw.send(message, transfer)
        },
        onMessage: (listener) => raw.onMessage(listener),
        onExit: (listener) => raw.onExit(listener),
        terminate: (force) => raw.terminate(force),
      }
      const random = seeded(9)
      const received: WorkerEvent[] = []
      const connection = connectWorker(transport, {
        methods: {
          resolveSnapshotPath: async (file) => file,
          writeSnapshot: async () => {},
          readTimings: async () => undefined,
        },
        // A slow reporter: each pack takes a few turns of the event loop.
        async onEvents(events) {
          received.push(...events)
          for (let i = int(random, 0, 4); i > 0; i--) await gap('immediate')
        },
      })
      try {
        for (const [index, seed] of [1, 2].entries()) {
          const before = received.length
          const done = await connection.run(job(`events:${COUNT}:${seed}`))
          assert.equal(done.seq, index)
          const file = received.slice(before)
          assert.equal(file.length, COUNT, 'no event lost or duplicated')
          assert.deepEqual(
            file.map(numberOf),
            Array.from({ length: COUNT }, (_, n) => n),
            'every event in order',
          )
        }
      } finally {
        await transport.terminate(false)
      }
      assert.ok(packsArrived >= (2 * COUNT) / 64, `${packsArrived} packs`)
      assert.ok(mostUnacked <= 8, `at most 8 packs unacked, saw ${mostUnacked}`)
    })
  })
}
