// The current-test service: `run`/`get`/`bind`, the executor's sync `running()` pointer, and the
// AsyncContextFrame check. The 23 propagation cases are in `propagation.test.ts`.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Frame, TaskId } from '@provino/types'
import { runScript } from '../internal/test-support.ts'
import { currentTest, usesAsyncContextFrame } from './current-test.ts'

function frame(name: string): Frame {
  return { test: null, hook: null, fileId: name as TaskId, attempt: 0 }
}

describe('currentTest.run and get', () => {
  test('get is undefined outside any run', () => {
    assert.equal(currentTest.get(), undefined)
  })

  test('get returns the frame given to run, and run returns what the function returned', () => {
    const a = frame('A')
    const result = currentTest.run(a, () => {
      assert.equal(currentTest.get(), a)
      return 'done'
    })
    assert.equal(result, 'done')
    assert.equal(currentTest.get(), undefined)
  })

  test('an inner run shadows the outer one, and the outer is back after it', () => {
    const a = frame('A')
    const b = frame('B')
    currentTest.run(a, () => {
      currentTest.run(b, () => assert.equal(currentTest.get(), b))
      assert.equal(currentTest.get(), a)
    })
  })

  test('the frame follows an await', async () => {
    const a = frame('A')
    await currentTest.run(a, async () => {
      await Promise.resolve()
      assert.equal(currentTest.get(), a)
    })
  })

  test('a throw inside run leaves no frame behind', () => {
    assert.throws(() =>
      currentTest.run(frame('A'), () => {
        throw new Error('boom')
      }),
    )
    assert.equal(currentTest.get(), undefined)
  })
})

describe('currentTest.bind', () => {
  test('a bound function sees the frame that was current when it was bound', () => {
    const a = frame('A')
    const bound = currentTest.run(a, () => currentTest.bind(() => currentTest.get()))
    assert.equal(bound(), a)
    assert.equal(
      currentTest.run(frame('B'), () => bound()),
      a,
    )
  })

  test('a function bound outside any run sees no frame, even when called inside one', () => {
    const bound = currentTest.bind(() => currentTest.get())
    assert.equal(
      currentTest.run(frame('A'), () => bound()),
      undefined,
    )
  })

  test('arguments and the result pass through', () => {
    const bound = currentTest.bind((a: number, b: number) => a + b)
    assert.equal(bound(2, 3), 5)
  })
})

describe('currentTest.running', () => {
  test('is undefined outside a test', () => {
    assert.equal(currentTest.running(), undefined)
  })

  test('is the frame of the test in progress while tests run one at a time', async () => {
    const seen: Array<string | undefined> = []
    await runScript(({ test }) => {
      test('first', () => {
        seen.push(currentTest.running()?.test?.name)
      })
      test('second', () => {
        seen.push(currentTest.running()?.test?.name)
      })
    })
    assert.deepEqual(seen, ['first', 'second'])
  })

  test('covers a test body that has awaited', async () => {
    let seen: string | undefined
    await runScript(({ test }) => {
      test('awaits', async () => {
        await Promise.resolve()
        seen = currentTest.running()?.test?.name
      })
    })
    assert.equal(seen, 'awaits')
  })

  test('is the test frame, not the hook frame, inside an each-hook', async () => {
    let seen: Frame | undefined
    await runScript(({ test, beforeEach }) => {
      beforeEach(() => {
        seen = currentTest.running()
      })
      test('t', () => {})
    })
    assert.equal(seen?.test?.name, 't')
    assert.equal(seen?.hook, null)
  })

  test('is unset inside a concurrent group, while get still tells the tests apart', async () => {
    const running: Array<Frame | undefined> = []
    const names: Record<string, string | undefined> = {}
    const gate = Promise.withResolvers<void>()
    await runScript(({ test }) => {
      test.concurrent('a', async () => {
        running.push(currentTest.running())
        await gate.promise
        names.a = currentTest.get()?.test?.name
      })
      test.concurrent('b', () => {
        running.push(currentTest.running())
        names.b = currentTest.get()?.test?.name
        gate.resolve()
      })
    })
    assert.deepEqual(running, [undefined, undefined])
    assert.deepEqual(names, { a: 'a', b: 'b' })
  })

  test('is set again for a sequential test after a concurrent group', async () => {
    let seen: string | undefined
    await runScript(({ test }) => {
      test.concurrent('c1', () => {})
      test.concurrent('c2', () => {})
      test('after', () => {
        seen = currentTest.running()?.test?.name
      })
    })
    assert.equal(seen, 'after')
  })

  test('is unset again once the file has run', async () => {
    await runScript(({ test }) => {
      test('t', () => {})
    })
    assert.equal(currentTest.running(), undefined)
  })
})

describe('the frame a test, hook or suite hook sees', () => {
  test('a test body sees its task, no hook, and its attempt number', async () => {
    let seen: Frame | undefined
    await runScript(({ test }) => {
      test('t', { retry: 1 }, () => {
        seen = currentTest.get()
        if (seen?.attempt === 0) throw new Error('first attempt fails')
      })
    })
    assert.equal(seen?.test?.name, 't')
    assert.equal(seen?.hook, null)
    assert.equal(seen?.attempt, 1)
  })

  test('an each-hook sees the test and the hook it is, owned by the suite it was declared on', async () => {
    let seen: Frame | undefined
    const run = await runScript(({ describe, test, beforeEach }) => {
      describe('d', () => {
        beforeEach(() => {
          seen = currentTest.get()
        })
        test('t', () => {})
      })
    })
    assert.equal(seen?.test?.name, 't')
    assert.deepEqual(seen?.hook, { kind: 'beforeEach', ownerId: run.tasks[1]?.id })
  })

  test('a beforeAll sees no test, and the file it runs in', async () => {
    let seen: Frame | undefined
    const run = await runScript(({ test, beforeAll }) => {
      beforeAll(() => {
        seen = currentTest.get()
      })
      test('t', () => {})
    })
    assert.equal(seen?.test, null)
    assert.equal(seen?.hook?.kind, 'beforeAll')
    assert.equal(seen?.fileId, run.tasks[0]?.id)
  })
})

describe('usesAsyncContextFrame', () => {
  test('is on by default from Node 24', () => {
    assert.equal(usesAsyncContextFrame('24.0.0', []), true)
    assert.equal(usesAsyncContextFrame('26.1.0', []), true)
  })

  test('is off by default before Node 24', () => {
    assert.equal(usesAsyncContextFrame('22.15.0', []), false)
    assert.equal(usesAsyncContextFrame('23.9.0', []), false)
  })

  test('--experimental-async-context-frame turns it on before Node 24', () => {
    assert.equal(usesAsyncContextFrame('22.15.0', ['--experimental-async-context-frame']), true)
  })

  test('--no-async-context-frame turns it off on Node 24', () => {
    assert.equal(usesAsyncContextFrame('24.0.0', ['--no-async-context-frame']), false)
  })

  test('--no-async-context-frame wins when both flags are given', () => {
    const flags = ['--experimental-async-context-frame', '--no-async-context-frame']
    assert.equal(usesAsyncContextFrame('24.0.0', flags), false)
  })

  test('answers for this process with no arguments', () => {
    assert.equal(typeof usesAsyncContextFrame(), 'boolean')
  })
})
