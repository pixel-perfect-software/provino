import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TaskId } from '@provino/types'
import { createDepsTable, type DepsEvent } from './deps-table.ts'

const fileId = 'f' as TaskId

function event(added: readonly string[], ids: readonly number[]): DepsEvent {
  return { type: 'deps', fileId, added, ids, t: 0 }
}

describe('a worker’s deps table', () => {
  it('rebuilds each file’s list, in the worker’s order, from the paths named once', () => {
    const table = createDepsTable()
    assert.deepEqual(table.resolve(event(['/a', '/b', '/c'], [2, 0, 1])), ['/c', '/a', '/b'])
    // The second file names one path and reuses two.
    assert.deepEqual(table.resolve(event(['/d'], [3, 1, 0])), ['/d', '/b', '/a'])
    // A third names nothing new.
    assert.deepEqual(table.resolve(event([], [3])), ['/d'])
    assert.deepEqual(table.resolve(event([], [])), [])
  })

  it('keeps one table per worker: another worker’s ids mean other paths', () => {
    const first = createDepsTable()
    const second = createDepsTable()
    first.resolve(event(['/a'], [0]))
    assert.deepEqual(second.resolve(event(['/z'], [0])), ['/z'])
    assert.deepEqual(first.resolve(event([], [0])), ['/a'])
  })

  it('rejects an id the worker never named, as a bad event', () => {
    const table = createDepsTable()
    table.resolve(event(['/a'], [0]))
    assert.throws(
      () => table.resolve(event([], [1])),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'ORCH_BAD_EVENT',
    )
  })
})
