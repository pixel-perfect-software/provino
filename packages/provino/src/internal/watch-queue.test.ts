import assert from 'node:assert/strict'
import { describe, it } from 'provino'
import { createWatchQueue } from './watch-queue.ts'

describe('the watch queue', () => {
  it('starts with every file', () => {
    const queue = createWatchQueue()
    assert.deepEqual(queue.take(), { kind: 'all' })
    assert.equal(queue.take(), undefined)
  })

  it('takes all before failed before changed before a rerun', () => {
    const queue = createWatchQueue()
    queue.take()
    queue.rerun()
    queue.changed(['/p/b.ts'])
    queue.failed()
    assert.deepEqual(queue.take(), { kind: 'failed' })
    assert.deepEqual(queue.take(), { kind: 'changed', paths: ['/p/b.ts'] })
    // The Enter that waited was answered by a run that was not the last one, so it stays.
    assert.deepEqual(queue.take(), { kind: 'changed', paths: ['/p/b.ts'] })
    assert.equal(queue.take(), undefined)
  })

  it('joins the batches that come before a run into one', () => {
    const queue = createWatchQueue()
    queue.take()
    queue.changed(['/p/b.ts'])
    queue.changed(['/p/a.ts', '/p/b.ts'])
    assert.deepEqual(queue.take(), { kind: 'changed', paths: ['/p/a.ts', '/p/b.ts'] })
  })

  it('all covers what waits, a queued Enter included', () => {
    const queue = createWatchQueue()
    queue.take()
    queue.changed(['/p/a.ts'])
    queue.failed()
    queue.rerun()
    queue.all()
    assert.deepEqual(queue.take(), { kind: 'all' })
    assert.equal(queue.take(), undefined)
  })

  it('an Enter does not repeat a run that just covered it', () => {
    const queue = createWatchQueue()
    queue.take()
    queue.failed()
    queue.take()
    queue.failed()
    queue.rerun()
    assert.deepEqual(queue.take(), { kind: 'failed' })
    assert.equal(queue.take(), undefined)
  })

  it('Enter alone runs the last run again', () => {
    const queue = createWatchQueue()
    queue.take()
    queue.changed(['/p/a.ts'])
    queue.take()
    queue.rerun()
    assert.deepEqual(queue.take(), { kind: 'changed', paths: ['/p/a.ts'] })
  })

  it('keeps the failed files: a run of all starts over, a partial run updates, a forgotten path goes', () => {
    const queue = createWatchQueue()
    queue.record({ kind: 'all' }, [
      { path: '/p/a.test.ts', state: 'fail' },
      { path: '/p/b.test.ts', state: 'fail' },
      { path: '/p/c.test.ts', state: 'pass' },
    ])
    assert.deepEqual([...queue.failedFiles], ['/p/a.test.ts', '/p/b.test.ts'])
    queue.record({ kind: 'failed' }, [
      { path: '/p/a.test.ts', state: 'pass' },
      { path: '/p/c.test.ts', state: 'fail' },
    ])
    assert.deepEqual([...queue.failedFiles].sort(), ['/p/b.test.ts', '/p/c.test.ts'])
    queue.forget(['/p/b.test.ts'])
    assert.deepEqual([...queue.failedFiles], ['/p/c.test.ts'])
    queue.record({ kind: 'all' }, [])
    assert.equal(queue.failedFiles.size, 0)
  })
})
