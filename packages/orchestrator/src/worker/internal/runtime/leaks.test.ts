import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WorkerError } from '../../errors.ts'
import { fileLeakWarning, leakedGlobalsOf, leakWarningEvent, workerLeakWarning } from './leaks.ts'

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
      fileLeakWarning('/p/a.test.js', ['__stuck', 'Symbol(s)']),
      'Provino: /p/a.test.js left 2 globals behind that the environment could not remove: __stuck, Symbol(s). Later files in this worker can see them.\n',
    )
    assert.equal(
      fileLeakWarning('/p/a.test.js', ['__stuck']),
      'Provino: /p/a.test.js left 1 global behind that the environment could not remove: __stuck. Later files in this worker can see it.\n',
    )
  })

  it('name the keys for a worker-scoped environment', () => {
    assert.equal(
      workerLeakWarning(['a', 'b']),
      'Provino: the environment could not remove 2 globals when the worker stopped: a, b.\n',
    )
  })

  it('are console events a console.warn call would have made, with no task', () => {
    const event = leakWarningEvent('text\n')
    assert.deepEqual(
      { ...event, t: typeof event.t },
      {
        type: 'console',
        taskId: null,
        stream: 'stderr',
        level: 'warn',
        text: 'text\n',
        origin: null,
        t: 'number',
      },
    )
  })
})
