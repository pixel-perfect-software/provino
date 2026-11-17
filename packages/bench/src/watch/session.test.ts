// The save loop against a fake session: no process, no watcher, no real wait.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProbeEvent } from './report.ts'
import { type Found, measureSaves, type SessionDriver } from './session.ts'

/**
 * A fake runner on a fake clock. `reacts(save)` says how a write is answered: the delay in ms from
 * the stamp to the run's start, or `undefined` for a write the watcher never sees (a watcher that
 * is not armed yet). A run that starts also ends 5 ms later.
 */
function fake(reacts: (save: number) => number | undefined, runLastsMs = 5) {
  let clock = 1_000
  const events: ProbeEvent[] = [
    { kind: 'run', at: clock },
    { kind: 'done', at: clock + 1 },
  ]
  const writes: number[] = []
  const waits: number[] = []
  const driver: SessionDriver = {
    write: async (save, stamp) => {
      writes.push(save)
      stamp(clock)
      const delay = reacts(save)
      if (delay !== undefined) {
        events.push({ kind: 'start', at: clock + delay })
        events.push({ kind: 'done', at: clock + delay + runLastsMs })
      }
    },
    waitFor: async (kind, from, atLeast, ms): Promise<Found | undefined> => {
      waits.push(ms)
      // Only an event inside the window counts, as it would arrive within `ms` of real time.
      const index = events.findIndex(
        (e, at) => at >= from && e.kind === kind && e.at >= atLeast && e.at <= clock + ms,
      )
      const event = events[index]
      if (event === undefined) {
        clock += ms
        return undefined
      }
      clock = Math.max(clock, event.at)
      return { event, next: index + 1 }
    },
    settle: async (ms) => {
      clock += ms
    },
    count: () => events.length,
  }
  return { driver, writes, waits, events }
}

const options = { saves: 3, settleMs: 250, timeoutMs: 60_000 }

test('an armed watcher: no warm-up retry, each save measured from its stamp to its run start', async () => {
  const delays = new Map([
    [2, 90],
    [3, 110],
    [4, 130],
    [5, 150],
  ])
  const run = fake((save) => delays.get(save))
  const latencies = await measureSaves(run.driver, options)
  // Save 2 is the warm-up that arms; saves 3, 4 and 5 are the measured ones.
  assert.deepEqual(latencies, [110, 130, 150])
  assert.deepEqual(run.writes, [2, 3, 4, 5])
})

test('a watcher that is slow to arm: unanswered warm-up saves are retried and left out of the numbers', async () => {
  // The watcher sees nothing until its third write; the rest are answered in 40 ms.
  const run = fake((save) => (save < 4 ? undefined : 40))
  const latencies = await measureSaves(run.driver, options)
  assert.deepEqual(latencies, [40, 40, 40])
  assert.deepEqual(run.writes, [2, 3, 4, 5, 6, 7])
  // The waits for the warm-ups grow: 250, 500, then the 1 s that is answered.
  assert.deepEqual(run.waits.slice(1, 4), [250, 500, 1_000])
})

test('a watcher that never arms fails after the bounded budget, naming the warm-up saves', async () => {
  const run = fake(() => undefined)
  await assert.rejects(
    measureSaves(run.driver, { ...options, armBudgetMs: 3_000 }),
    /did not start a run for \d+ warm-up saves in 3000 ms/,
  )
  // 250 + 500 + 1000 + 2000 passes 3,000 ms: four warm-up writes, no measured one.
  assert.deepEqual(run.writes, [2, 3, 4, 5])
})

test('the first run never ending is an error, and a measured save with no run is too', async () => {
  const none = fake(() => undefined)
  none.events.length = 0
  await assert.rejects(measureSaves(none.driver, options), /first run to end/)

  // Armed by save 2, then the watcher stops answering.
  const run = fake((save) => (save === 2 ? 10 : undefined))
  await assert.rejects(measureSaves(run.driver, options), /save 1's run to start/)
})

test('events from a late run of a retried warm-up never count as a measured save', async () => {
  // Save 2 is answered 600 ms late, after its 250 ms wait: the retry (save 3) is what arms. The late
  // run's `start` is older than the stamp of every measured save, so it is not taken for one.
  const run = fake((save) => (save === 2 ? 600 : save === 3 ? 20 : 30))
  const latencies = await measureSaves(run.driver, options)
  assert.deepEqual(latencies, [30, 30, 30])
})
