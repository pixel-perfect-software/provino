// T5.8: the test context's `skip` and `annotate`, and the try-task hook points. Against Vitest:
// `@provino/harness`'s runtime corpus (`context-shape`, `context-skip`).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { TestContext } from '@provino/types'
import { eventsOf, runScript } from '../internal/test-support.ts'

const vitest = { firstArg: 'context' } as const
const ctxFn = (fn: (ctx: TestContext) => unknown): never => fn as never

describe('ctx.skip', () => {
  test('skip() ends the test as skipped, with the dynamic reason and no error', async () => {
    const run = await runScript(({ test }, step) => {
      test(
        't',
        ctxFn((ctx) => {
          step('before')
          ctx.skip()
          step('after')
        }),
      )
    }, vitest)
    assert.deepEqual(run.trace, ['before'])
    assert.equal(run.states.t, 'skip')
    assert.equal(run.results.t?.skipReason, 'dynamic')
    assert.deepEqual(run.errors.t, [])
    assert.equal(run.file.state, 'skip', 'a file whose only test skipped is skipped')
  })

  test('skip(note) and skip(true, note) keep the note; skip(false) carries on', async () => {
    const run = await runScript(({ test }, step) => {
      test(
        'note',
        ctxFn((ctx) => ctx.skip('not today')),
      )
      test(
        'condition',
        ctxFn((ctx) => ctx.skip(true, 'conditional')),
      )
      test(
        'false',
        ctxFn((ctx) => {
          ctx.skip(false, 'ignored')
          step('reached')
        }),
      )
    }, vitest)
    assert.equal(run.results.note?.note, 'not today')
    assert.equal(run.results.condition?.note, 'conditional')
    assert.equal(run.states.false, 'pass')
    assert.deepEqual(run.trace, ['reached'])
  })

  test('afterEach and onTestFinished still run after a skip; onTestFailed does not', async () => {
    const run = await runScript(({ test, afterEach }, step) => {
      afterEach(() => step('afterEach'))
      test(
        't',
        ctxFn((ctx) => {
          ctx.onTestFinished(() => step('finished'))
          ctx.onTestFailed(() => step('failed'))
          ctx.skip()
        }),
      )
    }, vitest)
    assert.deepEqual(run.trace, ['afterEach', 'finished'])
  })

  test('skip() in a beforeEach skips the test: the body and later beforeEach hooks never run', async () => {
    const run = await runScript(({ test, beforeEach, afterEach }, step) => {
      beforeEach(
        ctxFn((ctx) => {
          step('first beforeEach')
          ctx.skip('by the hook')
        }),
      )
      beforeEach(() => step('second beforeEach'))
      afterEach(() => step('afterEach'))
      test('t', () => step('body'))
    }, vitest)
    assert.deepEqual(run.trace, ['first beforeEach', 'afterEach'])
    assert.equal(run.states.t, 'skip')
    assert.equal(run.results.t?.note, 'by the hook')
  })

  test('a failure after a skip outranks it', async () => {
    const run = await runScript(({ test, afterEach }) => {
      afterEach(() => {
        throw new Error('afterEach failed')
      })
      test(
        't',
        ctxFn((ctx) => ctx.skip()),
      )
    }, vitest)
    assert.equal(run.states.t, 'fail')
  })

  test('the attempt reports the skip', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        ctxFn((ctx) => ctx.skip()),
      )
    }, vitest)
    const [end] = eventsOf(run.events, 'test-attempt-end')
    assert.equal(end?.state, 'skip')
    assert.equal(end?.willRetry, false)
  })
})

describe('ctx.annotate', () => {
  test('emits an annotation event for the test, with the kind (default notice)', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        ctxFn(async (ctx) => {
          await ctx.annotate('hello')
          await ctx.annotate('careful', 'warning')
        }),
      )
    }, vitest)
    const events = eventsOf(run.events, 'annotation')
    assert.deepEqual(
      events.map((event) => [event.message, event.kind]),
      [
        ['hello', 'notice'],
        ['careful', 'warning'],
      ],
    )
    assert.ok(events.every((event) => run.tasks.some((task) => task.id === event.testId)))
  })

  test('records where it was called when locations are on', async () => {
    const run = await runScript(
      ({ test }) => {
        test(
          't',
          ctxFn((ctx) => ctx.annotate('here')),
        )
      },
      vitest,
      { locations: true },
    )
    const [event] = eventsOf(run.events, 'annotation')
    assert.match(event?.location?.file ?? '', /context\.test\.ts$/)
  })
})

describe('onBeforeTryTask and onAfterTryTask', () => {
  test('run around the hooks and the body of every attempt, in the attempt`s context', async () => {
    const run = await runScript(({ test, beforeEach, afterEach }, step, runtime) => {
      runtime.onBeforeTryTask((info) => {
        step(`before ${info.test.name} ${runtime.currentTest.get()?.test?.name}`)
      })
      runtime.onAfterTryTask((info) => {
        step(`after ${info.test.name} failed=${info.failed}`)
      })
      beforeEach(() => step('beforeEach'))
      afterEach(() => step('afterEach'))
      test('a', () => step('body a'))
      test('b', () => {
        throw new Error('b fails')
      })
    })
    assert.deepEqual(run.trace, [
      'before a a',
      'beforeEach',
      'body a',
      'afterEach',
      'after a failed=false',
      'before b b',
      'beforeEach',
      'afterEach',
      'after b failed=true',
    ])
  })

  test('onAfterTryTask runs before onTestFinished, and each retry is its own attempt', async () => {
    let calls = 0
    const run = await runScript(({ test }, step, runtime) => {
      runtime.onBeforeTryTask((info) => {
        step(`before ${info.attempt}`)
      })
      runtime.onAfterTryTask((info) => {
        step(`after ${info.attempt} failed=${info.failed}`)
      })
      test(
        't',
        { retry: 1 },
        ctxFn((ctx) => {
          ctx.onTestFinished(() => step('finished'))
          if (++calls === 1) throw new Error('first attempt')
        }),
      )
    }, vitest)
    assert.deepEqual(run.trace, [
      'before 0',
      'after 0 failed=true',
      'finished',
      'before 1',
      'after 1 failed=false',
      'finished',
    ])
    assert.equal(run.states.t, 'pass')
  })

  test('a listener that throws fails the attempt and skips the body', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      runtime.onBeforeTryTask(() => {
        throw new Error('cleanup failed')
      })
      test('t', () => step('body'))
    })
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.errors.t, ['cleanup failed'])
    assert.deepEqual(run.trace, [])
  })

  test('onAfterTryTask can fail the attempt, and the test`s onTestFailed sees it', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      runtime.onAfterTryTask(() => {
        throw new Error('expected 2 assertions')
      })
      test(
        't',
        ctxFn((ctx) => {
          ctx.onTestFailed(() => step('onTestFailed'))
        }),
      )
    }, vitest)
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.trace, ['onTestFailed'])
  })

  test('info.fail adds an error of the attempt each time, where a throw is one', async () => {
    const run = await runScript(({ test }, _step, runtime) => {
      runtime.onAfterTryTask((info) => {
        info.fail(new Error('first'))
        info.fail(new Error('second'))
      })
      test('t', () => undefined)
    })
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.errors.t, ['first', 'second'])
  })

  test('the function a registration returns removes the listener', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      const stop = runtime.onBeforeTryTask(() => step('listener'))
      test('one', () => {})
      test('two', () => {
        step('two')
      })
      stop()
    })
    assert.deepEqual(run.trace, ['two'])
  })
})
