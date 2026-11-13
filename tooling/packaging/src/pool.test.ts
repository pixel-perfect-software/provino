import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mapPool } from './pool.ts'

/** Lets every task that can run, run: a turn of the event loop, not a wait. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('mapPool', () => {
  test('runs at most `limit` tasks at once, and returns the results in item order', async () => {
    const gates = [0, 1, 2, 3, 4].map(() => Promise.withResolvers<void>())
    const started: number[] = []
    let running = 0
    let peak = 0
    const done = mapPool([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item)
      peak = Math.max(peak, ++running)
      await gates[item]?.promise
      running--
      return item * 10
    })
    await turn()
    assert.deepEqual(started, [0, 1])
    // The second finishes first: the next item starts, and the order of results is still the items'.
    gates[1]?.resolve()
    await turn()
    assert.deepEqual(started, [0, 1, 2])
    for (const gate of [...gates].reverse()) gate.resolve()
    assert.deepEqual(await done, [0, 10, 20, 30, 40])
    assert.equal(peak, 2)
  })

  test('is fine with fewer items than lanes, and with none', async () => {
    assert.deepEqual(await mapPool([1, 2], 8, async (item) => item + 1), [2, 3])
    assert.deepEqual(await mapPool([], 4, async (item: number) => item), [])
  })

  test('a rejection rejects the whole', async () => {
    await assert.rejects(
      mapPool([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('two failed')
        return item
      }),
      /two failed/,
    )
  })
})
