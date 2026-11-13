// The default `workerMemoryLimit` (T9.5, Track 9 §Pool 3): max(512 MiB, 25% of the memory
// available / maxWorkers), the memory being the container's cap when there is one.
import assert from 'node:assert/strict'
import { totalmem } from 'node:os'
import { describe, it } from 'node:test'
import { defaultWorkerMemoryLimit } from './run.ts'

const MIB = 1024 * 1024

/** The memory the process may use: the container's cap if it has one, never more than the machine's. */
function available(): number {
  const constrained: unknown = process.constrainedMemory()
  return typeof constrained === 'number' && constrained > 0
    ? Math.min(constrained, totalmem())
    : totalmem()
}

/** Runs `body` with `process.constrainedMemory()` answering `value`, then puts it back. */
function withConstrainedMemory(value: number, body: () => void): void {
  const original = process.constrainedMemory
  process.constrainedMemory = () => value
  try {
    body()
  } finally {
    process.constrainedMemory = original
  }
}

describe('defaultWorkerMemoryLimit', () => {
  it('is a quarter of the memory shared by the workers, and never under 512 MiB', () => {
    for (const workers of [1, 2, 4, 8, 11, 64, 1024]) {
      assert.equal(
        defaultWorkerMemoryLimit(workers),
        Math.max(512 * MIB, Math.floor((0.25 * available()) / workers)),
        `${workers} workers`,
      )
    }
    assert.equal(defaultWorkerMemoryLimit(1_000_000), 512 * MIB, 'many workers: the floor')
  })

  it('shrinks as workers are added, until the floor', () => {
    let last = Number.POSITIVE_INFINITY
    for (const workers of [1, 2, 4, 8, 16, 32, 64, 128]) {
      const limit = defaultWorkerMemoryLimit(workers)
      assert.ok(limit <= last, `${workers} workers: ${limit} is not above ${last}`)
      assert.ok(limit >= 512 * MIB)
      last = limit
    }
  })

  it('reads a cgroup with no limit, which reports about 2^64 bytes, as the machine', () => {
    // GitHub's Linux runners: `constrainedMemory()` is 18446744073709552000 there.
    withConstrainedMemory(2 ** 64, () => {
      assert.equal(defaultWorkerMemoryLimit(1), Math.max(512 * MIB, Math.floor(0.25 * totalmem())))
      assert.equal(defaultWorkerMemoryLimit(1_000_000), 512 * MIB, 'many workers: the floor')
    })
  })

  it('keeps a container cap under the machine', () => {
    withConstrainedMemory(8 * 1024 * MIB, () => {
      assert.equal(defaultWorkerMemoryLimit(1), 2 * 1024 * MIB)
      assert.equal(defaultWorkerMemoryLimit(8), 512 * MIB)
    })
  })

  it('treats a count under 1 as 1', () => {
    assert.equal(defaultWorkerMemoryLimit(0), defaultWorkerMemoryLimit(1))
  })
})
