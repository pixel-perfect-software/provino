import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inParallel } from './in-parallel.ts'

const yieldOnce = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

test('every item is worked on once, and never more than the limit at a time', async () => {
  const items = Array.from({ length: 20 }, (_, index) => index)
  const seen: number[] = []
  let active = 0
  let peak = 0
  await inParallel(items, 4, async (item) => {
    active += 1
    peak = Math.max(peak, active)
    await yieldOnce()
    seen.push(item)
    active -= 1
  })
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    items,
  )
  assert.equal(peak, 4)
})

test('a limit above the item count starts one worker per item, and no items start none', async () => {
  let peak = 0
  let active = 0
  await inParallel([1, 2, 3], 16, async () => {
    active += 1
    peak = Math.max(peak, active)
    await yieldOnce()
    active -= 1
  })
  assert.equal(peak, 3)
  await inParallel([], 16, async () => assert.fail('nothing to work on'))
})
