import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WorkerError } from '../../errors.ts'
import { createLeakCheck, fileLeakEvent, leakedGlobalsOf, workerLeakEvent } from './leaks.ts'

describe('leakedGlobalsOf', () => {
  it('reads the keys of a report, and nothing from a clean teardown', () => {
    assert.deepEqual(leakedGlobalsOf({ leakedGlobals: ['a', 'Symbol(b)'] }, 'x'), [
      'a',
      'Symbol(b)',
    ])
    assert.deepEqual(leakedGlobalsOf({ leakedGlobals: [] }, 'x'), [])
    for (const clean of [undefined, null, 3, 'text', {}, []]) {
      assert.deepEqual(leakedGlobalsOf(clean, 'x'), [], String(clean))
    }
  })

  it('throws ORCH_BAD_ENVIRONMENT, naming the environment, for a report of the wrong shape', () => {
    for (const bad of [{ leakedGlobals: 'a' }, { leakedGlobals: [1] }, { leakedGlobals: null }]) {
      assert.throws(
        () => leakedGlobalsOf(bad, 'jsdom'),
        (error: unknown) =>
          error instanceof WorkerError &&
          error.code === 'ORCH_BAD_ENVIRONMENT' &&
          error.message.includes('"jsdom"'),
        JSON.stringify(bad),
      )
    }
  })
})

describe('the leak warnings', () => {
  it('name the file and the keys, and say later files in the worker can see them', () => {
    assert.equal(
      fileLeakEvent('/p/a.test.js', ['__stuck', 'Symbol(s)']).text,
      'Provino: /p/a.test.js left 2 globals behind that the environment could not remove: __stuck, Symbol(s). Later files in this worker can see them.\n',
    )
    assert.equal(
      fileLeakEvent('/p/a.test.js', ['__stuck']).text,
      'Provino: /p/a.test.js left 1 global behind that the environment could not remove: __stuck. Later files in this worker can see it.\n',
    )
  })

  it('name the keys for a worker-scoped environment', () => {
    assert.equal(
      workerLeakEvent(['a', 'b']).text,
      'Provino: the environment could not remove 2 globals when the worker stopped: a, b.\n',
    )
  })

  it('are console events a console.warn call would have made, with no task', () => {
    const warnings = [
      [
        fileLeakEvent('/p/a.test.js', ['a']),
        'Provino: /p/a.test.js left 1 global behind that the environment could not remove: a. Later files in this worker can see it.\n',
      ],
      [
        workerLeakEvent(['a']),
        'Provino: the environment could not remove 1 global when the worker stopped: a.\n',
      ],
    ] as const
    for (const [event, text] of warnings) {
      assert.deepEqual(
        { ...event, t: typeof event.t },
        {
          type: 'console',
          taskId: null,
          stream: 'stderr',
          level: 'warn',
          text,
          origin: null,
          t: 'number',
        },
      )
    }
  })
})

describe('createLeakCheck (--detectLeaks)', () => {
  /** Makes an object only the returned check can see, so a collection can free it. */
  function checkOf(keep: unknown[]): () => Promise<boolean> {
    const target = { big: new Array(1000).fill(0) }
    keep.push(target)
    return createLeakCheck([target])
  }

  it('says a target something still holds is leaking', async () => {
    const holder: unknown[] = []
    const check = checkOf(holder)
    assert.equal(await check(), true)
    assert.equal(holder.length, 1)
  })

  it('says a target nothing holds any more is not', async () => {
    const holder: unknown[] = []
    const check = checkOf(holder)
    holder.length = 0
    assert.equal(await check(), false)
  })

  it('reports one target of several that is still held', async () => {
    const held = { held: true }
    const check = ((): (() => Promise<boolean>) => createLeakCheck([{}, held]))()
    assert.equal(await check(), true)
    assert.ok(held.held)
  })
})
