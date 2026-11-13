// How a worker thread's end becomes a `WorkerExit` (T9.5): a heap OOM is `oom` with or without a
// limit the transport set.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getHeapStatistics } from 'node:v8'
import { threadExit } from './threads.ts'

describe('threadExit', () => {
  it('is the exit code when the thread did not run out of memory', () => {
    assert.deepEqual(threadExit(0, false, undefined), { type: 'exit', code: 0 })
    assert.deepEqual(threadExit(3, false, 64), { type: 'exit', code: 3 })
  })

  it('is `oom` with the limit the thread ran under', () => {
    assert.deepEqual(threadExit(1, true, 64), { type: 'oom', limitMb: 64 })
  })

  it("is `oom` with V8's default limit when no limit is known, as a fork's is", () => {
    const fallback = Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024))
    assert.deepEqual(threadExit(1, true, undefined), { type: 'oom', limitMb: fallback })
  })
})
