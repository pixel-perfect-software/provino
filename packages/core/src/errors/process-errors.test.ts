// T5.11: who an error is charged to when the process raises it, under `errors.lateErrors`. The
// listeners are tested on an EventEmitter standing in for `process`; against the real runners:
// `@provino/harness`'s runtime corpus (`errors-*`, run in a child process).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'provino'
import { eventsOf, runScript } from '../internal/test-support.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const owner = { errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' } } as const
const run = { errors: { lateErrors: 'report-run', hasAssertionsWhenFailed: 'skip' } } as const
const perFile = { errors: { lateErrors: 'fail-owner', processListeners: 'per-file' } } as const
const alongside = { errors: { lateErrors: 'fail-owner', processListeners: 'alongside' } } as const
/** One macrotask: what a file left in its microtasks has run, and an immediate it set has fired. */
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

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

  test('an error charged late to a test of an earlier file does not fail the file running now', async () => {
    const process = new EventEmitter()
    let files = 0
    const first = await runScript(({ test }, _step, runtime) => {
      files++
      if (files > 1) {
        test('in the second file', () => sleep(80))
        return
      }
      runtime.captureProcessErrors(process)
      test('owner', () => {
        setTimeout(
          () => process.emit('uncaughtException', new Error('late'), 'uncaughtException'),
          30,
        )
      })
    }, owner)
    assert.equal(first.file.state, 'pass')
    const second = await first.runtime.runFile('/project/second.test.ts')
    const [event, ...rest] = eventsOf(first.events, 'unhandled-error')
    assert.equal(rest.length, 0, 'the error is still reported, once')
    assert.equal(event?.error.message, 'late')
    assert.equal(second.state, 'pass', 'it was the earlier file`s test that was charged')
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

  test('an error no test or hook raised, while a file runs, is charged to that file', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      const { promise: started, resolve: start } = Promise.withResolvers<void>()
      const { promise: raised, resolve: raise } = Promise.withResolvers<void>()
      // Registered as the file loads: the reaction runs in no test's or hook's context.
      void started.then(() => {
        process.emit('uncaughtException', new Error('module scope'), 'uncaughtException')
        raise()
      })
      test('t', async () => {
        start()
        await raised
      })
    }, owner)
    const [event, ...rest] = eventsOf(result.events, 'unhandled-error')
    assert.equal(rest.length, 0)
    assert.equal(event?.ownerId, result.tasks.find((task) => task.type === 'file')?.id)
    assert.equal(event?.error.message, 'module scope')
    assert.equal(result.states.t, 'pass')
    assert.equal(result.file.state, 'fail')
  })

  test('a rejection no test or hook made is held to the end of the file, then charged to it', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      const { promise: started, resolve: start } = Promise.withResolvers<void>()
      const { promise: raised, resolve: raise } = Promise.withResolvers<void>()
      // Registered as the file loads: the reactions run in no test's or hook's context.
      const handled = Promise.resolve()
      void started
        .then(() => {
          process.emit('unhandledRejection', new Error('left'), Promise.resolve())
          process.emit('unhandledRejection', new Error('handled later'), handled)
        })
        .then(() => {
          process.emit('rejectionHandled', handled)
          raise()
        })
      test('t', async () => {
        start()
        await raised
      })
    }, owner)
    const charged = eventsOf(result.events, 'unhandled-error')
    assert.deepEqual(
      charged.map((event) => [event.ownerId, event.origin, event.error.message]),
      [[result.tasks.find((task) => task.type === 'file')?.id, 'unhandledRejection', 'left']],
    )
    const types = result.events.map((e) => e.type)
    assert.ok(types.indexOf('unhandled-error') < types.indexOf('file-end'))
    assert.equal(result.file.state, 'fail')
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

  test('an error no test or hook raised, while a file runs, is still the run’s, at once', async () => {
    const process = new EventEmitter()
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      // Scheduled as the file loads: under `fail-owner` this would be the file's.
      setTimeout(() => {
        process.emit('uncaughtException', new Error('module scope'), 'uncaughtException')
        process.emit('unhandledRejection', new Error('left'), Promise.resolve())
      }, 5)
      test('t', () => sleep(40))
    }, run)
    const events = eventsOf(result.events, 'unhandled-error')
    assert.deepEqual(
      events.map((event) => [event.ownerId, event.origin, event.error.message]),
      [
        [null, 'uncaughtException', 'module scope'],
        [null, 'unhandledRejection', 'left'],
      ],
    )
    const types = result.events.map((e) => e.type)
    assert.ok(types.indexOf('unhandled-error') < types.indexOf('test-end'), 'at once')
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

describe('processListeners', () => {
  /** A script whose one test leaves a rejection Node reports a macrotask later, after the file. */
  const leavesRejection =
    (process: EventEmitter): Parameters<typeof runScript>[0] =>
    ({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('leaves it', () => {
        setImmediate(() => {
          process.emit(
            'unhandledRejection',
            new Error('reported after the file'),
            Promise.resolve(),
          )
        })
      })
    }

  test('per-file: while a file runs they are the process’s only ones, and after it its own are back', async () => {
    const process = new EventEmitter()
    const own = (): void => {}
    process.on('unhandledRejection', own)
    let during: unknown
    await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('t', () => {
        during = {
          own: process.rawListeners('unhandledRejection').includes(own),
          counts: ['uncaughtException', 'unhandledRejection', 'rejectionHandled'].map((event) =>
            process.listenerCount(event),
          ),
        }
      })
    }, perFile)
    assert.deepEqual(during, { own: false, counts: [1, 1, 1] })
    // The process's own listener is back alone; an event with none of its own keeps the runtime's.
    assert.deepEqual(process.rawListeners('unhandledRejection'), [own])
    assert.equal(process.listenerCount('uncaughtException'), 1)
    assert.equal(process.listenerCount('rejectionHandled'), 1)
  })

  test('per-file: a rejection Node reports after the file goes to the process’s own listener, and is charged to nothing', async () => {
    const process = new EventEmitter()
    const heard: string[] = []
    process.on('unhandledRejection', (reason: Error) => heard.push(reason.message))
    const result = await runScript(leavesRejection(process), perFile)
    await nextMacrotask()
    assert.deepEqual(heard, ['reported after the file'])
    assert.deepEqual(eventsOf(result.events, 'unhandled-error'), [])
    assert.equal(result.states['leaves it'], 'pass')
  })

  test('per-file: with no listener of the process’s own, the runtime still charges it to the test that left it', async () => {
    const process = new EventEmitter()
    const result = await runScript(leavesRejection(process), perFile)
    await nextMacrotask()
    const leaves = result.tasks.find((task) => task.type === 'test' && task.name === 'leaves it')
    const [event, ...rest] = eventsOf(result.events, 'unhandled-error')
    assert.equal(rest.length, 0)
    assert.equal(event?.ownerId, leaves?.id)
    assert.equal(event?.error.message, 'reported after the file')
  })

  test('alongside: it is charged to the test that left it even when the process has a listener of its own', async () => {
    const process = new EventEmitter()
    const heard: string[] = []
    process.on('unhandledRejection', (reason: Error) => heard.push(reason.message))
    const result = await runScript(leavesRejection(process), alongside)
    await nextMacrotask()
    assert.deepEqual(heard, ['reported after the file'])
    assert.equal(eventsOf(result.events, 'unhandled-error').length, 1)
  })

  test('per-file: the calls are jest-circus’s, so a target whose methods a library replaced ends as it does under Jest', async () => {
    const calls: string[] = []
    const process = new EventEmitter()
    for (const method of ['on', 'removeListener', 'removeAllListeners', 'rawListeners'] as const) {
      const original = process[method].bind(process) as (...args: unknown[]) => unknown
      Object.defineProperty(process, method, {
        value: (event: string, ...rest: unknown[]) => {
          if (event === 'unhandledRejection') calls.push(method)
          return original(event, ...rest)
        },
      })
    }
    const own = (): void => {}
    process.on('unhandledRejection', own)
    calls.length = 0
    const result = await runScript(({ test }, _step, runtime) => {
      runtime.captureProcessErrors(process)
      test('t', () => {})
    }, perFile)
    // Placed while the file ran (`on`, then circus's take-over), then circus's restore.
    assert.deepEqual(calls, [
      'on',
      'rawListeners',
      'removeListener',
      'rawListeners',
      'removeAllListeners',
      'on',
      'removeListener',
      'on',
    ])
    assert.equal(result.file.state, 'pass')
    assert.deepEqual(process.rawListeners('unhandledRejection'), [own])
  })

  test('per-file: the function captureProcessErrors returns puts back what a running file took off', async () => {
    const process = new EventEmitter()
    const own = (): void => {}
    process.on('uncaughtException', own)
    await runScript(({ test }, _step, runtime) => {
      const stop = runtime.captureProcessErrors(process)
      test('t', () => {
        stop()
        assert.deepEqual(process.rawListeners('uncaughtException'), [own])
        assert.equal(process.listenerCount('unhandledRejection'), 0)
      })
    }, perFile)
    assert.deepEqual(process.rawListeners('uncaughtException'), [own])
  })
})
