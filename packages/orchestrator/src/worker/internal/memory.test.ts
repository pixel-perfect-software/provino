// The decision a worker makes after each file (collect once before reporting a heap over the pool's
// limit), over a heap and a collector the test controls; and the real collector, which frees
// garbage whether or not `--expose-gc` is on and leaves `gc` hidden from later contexts.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { collectGarbage, memoryAfterFile, usedHeapBytes } from './memory.ts'

const MIB = 1024 * 1024

/** Allocates 160 MB nothing refers to and returns the heap while the allocation is fresh. */
function heapWithGarbage(): number {
  new Array(20_000_000).fill(0)
  return usedHeapBytes()
}

/** A weak reference to an object only it refers to, made in a frame of its own. */
function weakObject(): WeakRef<object> {
  return new WeakRef({ big: new Array(1000).fill(0) })
}

/** A heap that reads `before` until a collection has run and `after` from then on. */
function heap(before: number, after: number) {
  let collections = 0
  return {
    read: (): number => (collections === 0 ? before : after),
    collect: (): void => {
      collections++
    },
    collections: (): number => collections,
  }
}

describe('memoryAfterFile', () => {
  it('reports the heap as it is, and collects nothing, when the pool has no limit', () => {
    const h = heap(900 * MIB, 100 * MIB)
    assert.equal(memoryAfterFile(undefined, h.read, h.collect), 900 * MIB)
    assert.equal(h.collections(), 0)
  })

  it('collects nothing for a limit of 0: the pool replaces the worker after every file whatever the heap says', () => {
    const h = heap(900 * MIB, 100 * MIB)
    assert.equal(memoryAfterFile(0, h.read, h.collect), 900 * MIB)
    assert.equal(h.collections(), 0)
  })

  it('collects nothing for a heap under the limit, or exactly at it (the pool replaces over, not at)', () => {
    for (const used of [100 * MIB, 512 * MIB - 1, 512 * MIB]) {
      const h = heap(used, 1)
      assert.equal(memoryAfterFile(512 * MIB, h.read, h.collect), used)
      assert.equal(h.collections(), 0, `a heap of ${used} bytes under a limit of 512 MiB`)
    }
  })

  it('collects once for a heap over the limit, and reports the heap after it: garbage alone does not replace the worker', () => {
    const h = heap(1100 * MIB, 610 * MIB)
    const reported = memoryAfterFile(1024 * MIB, h.read, h.collect)
    assert.equal(reported, 610 * MIB)
    assert.ok(reported <= 1024 * MIB, 'under the limit: the pool keeps the worker')
    assert.equal(h.collections(), 1)
  })

  it('still reports a heap over the limit after the collection: the worker holds it, so the pool replaces it', () => {
    const h = heap(1500 * MIB, 1200 * MIB)
    const reported = memoryAfterFile(1024 * MIB, h.read, h.collect)
    assert.equal(reported, 1200 * MIB)
    assert.ok(reported > 1024 * MIB)
    assert.equal(h.collections(), 1, 'one collection, never a second')
  })

  it('reports the first reading when the collection cannot run: a worker must never lose its fileDone', () => {
    // V8's flags are process-wide: a thread that restored `--no-expose-gc` between another's set
    // and its context leaves that one with no `gc` to call.
    let reads = 0
    const reported = memoryAfterFile(
      1024 * MIB,
      () => {
        reads++
        return 1100 * MIB
      },
      () => {
        throw new ReferenceError('gc is not defined')
      },
    )
    assert.equal(reported, 1100 * MIB)
    assert.equal(reads, 1, 'no second reading of a heap that was not collected')
  })

  it('reads the real heap and collects for real by default: 160 MB of garbage is gone from what it reports', () => {
    const before = heapWithGarbage()
    const reported = memoryAfterFile(1)
    assert.ok(
      before - reported >= 100 * MIB,
      `the heap went from ${before} to ${reported} bytes, a collection frees 160 MB of garbage`,
    )
  })
})

describe('collectGarbage', () => {
  it('leaves `gc` hidden from the contexts made after it, as it found it', (t) => {
    if (globalThis.gc !== undefined) {
      t.skip('node runs with --expose-gc')
      return
    }
    collectGarbage()
    assert.equal(globalThis.gc, undefined)
    assert.equal(runInNewContext('typeof gc'), 'undefined')
    // It runs again, and the flag it set the first time did not stay.
    collectGarbage()
    assert.equal(runInNewContext('typeof gc'), 'undefined')
  })

  it('collects a weakly held object', async () => {
    const ref = weakObject()
    // A `WeakRef` keeps its target until the end of the job that made it.
    await new Promise<void>((resolve) => setImmediate(resolve))
    collectGarbage()
    assert.equal(ref.deref(), undefined)
  })
})
