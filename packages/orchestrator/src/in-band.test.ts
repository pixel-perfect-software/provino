import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type InBandInput, shouldRunInBand } from './in-band.ts'

/** jest-core `testSchedulerHelper.ts`'s numbers: `SLOW_TEST_TIME` and `tests.length <= 20`. */
const JEST = { single: true, fastFileCount: 20, slowMs: 1000 }
const NEUTRAL = { single: false, fastFileCount: 0, slowMs: 0 }

const input = (over: Partial<InBandInput>): InBandInput => ({
  policy: JEST,
  maxWorkers: 4,
  fileCount: 5,
  timingsMs: [],
  ...over,
})

describe('shouldRunInBand', () => {
  it('is on for a run asked to be in band, or finding open handles, whatever else says', () => {
    for (const over of [{ runInBand: true }, { detectOpenHandles: true }]) {
      assert.equal(
        shouldRunInBand(input({ ...over, policy: NEUTRAL, workerMemoryLimit: true })),
        true,
      )
      assert.equal(shouldRunInBand(input({ ...over, watch: true })), true)
    }
  })

  it('is off in watch mode and with a memory limit, which the policy never overrides', () => {
    assert.equal(shouldRunInBand(input({ fileCount: 1, watch: true })), false)
    assert.equal(shouldRunInBand(input({ fileCount: 1, workerMemoryLimit: true })), false)
    assert.equal(shouldRunInBand(input({ maxWorkers: 1, workerMemoryLimit: true })), false)
  })

  it('is on for one file, or one worker, under `single`', () => {
    assert.equal(shouldRunInBand(input({ fileCount: 1 })), true)
    assert.equal(shouldRunInBand(input({ fileCount: 0 })), true)
    assert.equal(shouldRunInBand(input({ maxWorkers: 1 })), true)
    assert.equal(shouldRunInBand(input({ maxWorkers: 2, fileCount: 2 })), false)
    assert.equal(shouldRunInBand(input({ policy: NEUTRAL, fileCount: 1, maxWorkers: 1 })), false)
  })

  it('is on for up to `fastFileCount` files when some have a time and every time is under `slowMs`', () => {
    assert.equal(shouldRunInBand(input({ timingsMs: [10, 999] })), true)
    assert.equal(shouldRunInBand(input({ timingsMs: [10, 1000] })), false)
    assert.equal(shouldRunInBand(input({ timingsMs: [] })), false)
    assert.equal(shouldRunInBand(input({ fileCount: 20, timingsMs: [5] })), true)
    assert.equal(shouldRunInBand(input({ fileCount: 21, timingsMs: [5] })), false)
    assert.equal(shouldRunInBand(input({ policy: NEUTRAL, timingsMs: [5] })), false)
  })
})
