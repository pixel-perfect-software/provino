// T5.11: who an error is charged to when the process raises it, under `errors.lateErrors`. The
// listeners are tested on an EventEmitter standing in for `process`; against the real runners:
// `@provino/harness`'s runtime corpus (`errors-*`, run in a child process).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { eventsOf, runScript } from '../internal/test-support.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const owner = { errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' } } as const
const run = { errors: { lateErrors: 'report-run', hasAssertionsWhenFailed: 'skip' } } as const

describe('fail-owner', () => {
  test('an exception raised while its test runs fails that test', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      const stop = runtime.captureProcessErrors(process)
      test('t', async () => {
        process.emit('uncaughtException', new Error('thrown while running'), 'uncaughtException')
        await sleep(1)
      })
      test('after', () => stop())
    }, owner)
    assert.deepEqual(result.errors.t, ['thrown while running'])
    assert.equal(result.states.after, 'pass')
    assert.deepEqual(eventsOf(result.events, 'unhandled-error'), [])
  })

  test('an exception from a timer of an ended test is charged to that test, as an event', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('owner', () => {
        setTimeout(
          () => process.emit('uncaughtException', new Error('late'), 'uncaughtException'),
          5,
        )
      })
      test('running when it fires', () => sleep(40))
    }, owner)
    const [event, ...rest] = eventsOf(result.events, 'unhandled-error')
    assert.equal(rest.length, 0)
    const ownerTask = result.tasks.find((task) => task.type === 'test' && task.name === 'owner')
    assert.equal(event?.ownerId, ownerTask?.id)
    assert.equal(event?.origin, 'uncaughtException')
    assert.equal(event?.error.message, 'late')
    assert.equal(result.states['running when it fires'], 'pass')
    assert.equal(result.file.state, 'fail', 'the file fails for a test that was charged late')
  })

  test('a rejection waits for the end of the body, then fails the test', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('t', async () => {
        process.emit('unhandledRejection', new Error('rejected'), Promise.resolve())
        await sleep(1)
      })
    }, owner)
    assert.deepEqual(result.errors.t, ['rejected'])
    assert.deepEqual(eventsOf(result.events, 'unhandled-error'), [])
  })

  test('a rejection that gets its handler first is dropped', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('t', async () => {
        const promise = Promise.resolve()
        process.emit('unhandledRejection', new Error('rejected'), promise)
        await sleep(1)
        process.emit('rejectionHandled', promise)
      })
    }, owner)
    assert.equal(result.states.t, 'pass')
  })

  test('a rejection left by an ended test is held to the end of the file, then charged', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, step, runtime) => {
      runtime.captureProcessErrors(process)
      let promise: Promise<void> | undefined
      test('owner', () => {
        setTimeout(() => {
          promise = Promise.resolve()
          process.emit('unhandledRejection', new Error('rejected late'), promise)
        }, 5)
      })
      test('later', async () => {
        await sleep(30)
        step('later ends')
      })
    }, owner)
    const [event] = eventsOf(result.events, 'unhandled-error')
    assert.equal(event?.origin, 'unhandledRejection')
    assert.equal(event?.error.message, 'rejected late')
    // The event comes before the file ends.
    const types = result.events.map((e) => e.type)
    assert.ok(types.indexOf('unhandled-error') < types.indexOf('file-end'))
  })

  test('an error raised in a beforeAll hook`s context is charged to the file', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test, beforeAll }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      beforeAll(() => {
        setTimeout(
          () => process.emit('uncaughtException', new Error('from a hook'), 'uncaughtException'),
          5,
        )
      })
      test('t', () => sleep(40))
    }, owner)
    const [event] = eventsOf(result.events, 'unhandled-error')
    assert.equal(event?.ownerId, result.tasks.find((task) => task.type === 'file')?.id)
    assert.equal(result.file.state, 'fail')
    assert.equal(result.states.t, 'pass')
  })

  test('an error with no owner is charged to the run', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('t', () => {})
    }, owner)
    // The file is over and nothing runs: the worker keeps its listeners for its lifetime.
    process.emit('uncaughtException', new Error('between files'), 'uncaughtException')
    const [event] = eventsOf(result.events, 'unhandled-error')
    assert.equal(event?.ownerId, null)
    assert.equal(event?.error.message, 'between files')
  })
})

describe('report-run', () => {
  test('every such error is an error of the run, at once, and the test passes', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('t', async () => {
        process.emit('uncaughtException', new Error('x'), 'uncaughtException')
        process.emit('unhandledRejection', new Error('y'), Promise.resolve())
        await sleep(1)
      })
    }, run)
    const events = eventsOf(result.events, 'unhandled-error')
    assert.deepEqual(
      events.map((event) => [event.ownerId, event.origin, event.error.message]),
      [
        [null, 'uncaughtException', 'x'],
        [null, 'unhandledRejection', 'y'],
      ],
    )
    assert.equal(result.states.t, 'pass')
    assert.equal(result.file.state, 'pass')
  })

  test('a rejection that is handled later is still an error', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('t', async () => {
        const promise = Promise.resolve()
        process.emit('unhandledRejection', new Error('y'), promise)
        process.emit('rejectionHandled', promise)
      })
    }, run)
    assert.equal(eventsOf(result.events, 'unhandled-error').length, 1)
  })
})

describe('the listeners', () => {
  test('are removed by the function captureProcessErrors returns', async () => {
    const process = new EventEmitter()
    await runScript(({ test }, _step, runtime) => {
      const stop = runtime.captureProcessErrors(process)
      assert.equal(process.listenerCount('uncaughtException'), 1)
      assert.equal(process.listenerCount('unhandledRejection'), 1)
      assert.equal(process.listenerCount('rejectionHandled'), 1)
      stop()
      assert.equal(process.listenerCount('uncaughtException'), 0)
      assert.equal(process.listenerCount('unhandledRejection'), 0)
      assert.equal(process.listenerCount('rejectionHandled'), 0)
      test('t', () => {})
    }, owner)
  })

  test('with the real process, core installs nothing until it is asked', async () => {
    const before = globalThis.process.listenerCount('uncaughtException')
    await runScript(({ test }) => {
      test('t', () => {})
    }, owner)
    assert.equal(globalThis.process.listenerCount('uncaughtException'), before)
  })
})
