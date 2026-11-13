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

  test('`info.ctx` is the context the attempt’s hooks and body get, built when read', async () => {
    const run = await runScript(({ test, beforeEach }, step, runtime) => {
      let seen: TestContext | undefined
      runtime.onBeforeTryTask((info) => {
        // A getter on the prototype, not an own key: a spread of `info` does not carry it.
        const first = info.ctx
        step(`own ${Object.keys(info).includes('ctx')} read ${first === info.ctx}`)
        seen = first
      })
      beforeEach(ctxFn((ctx) => step(`beforeEach same ${ctx === seen}`)))
      test(
        't',
        ctxFn((ctx) => step(`body same ${ctx === seen}`)),
      )
    }, vitest)
    assert.deepEqual(run.trace, ['own false read true', 'beforeEach same true', 'body same true'])
  })
})

describe('the context object (B21f)', () => {
  // The keys are assigned, as Vitest 5.0's `createTestContext` assigns them, so they are plain data
  // properties and the object is the attempt's own: a write is seen by its hooks, its body and
  // its callbacks, and by no other attempt.
  test('each key is a writable data property, and a write reaches the whole attempt only', async () => {
    const flagsOf = (ctx: TestContext): string =>
      Object.keys(ctx)
        .map((key) => {
          const d = Object.getOwnPropertyDescriptor(ctx, key)
          return `${key}:${d !== undefined && 'value' in d}${d?.writable === true}${d?.enumerable === true}`
        })
        .join(' ')
    const run = await runScript(({ test, beforeEach, afterEach }, step) => {
      type Marked = TestContext & { mark?: string }
      beforeEach(
        ctxFn((ctx: Marked) => {
          step(`keys ${flagsOf(ctx)}`)
          step(`mark before ${ctx.mark}`)
          ctx.mark = 'set in beforeEach'
        }),
      )
      test(
        'one',
        ctxFn((ctx: Marked) => {
          step(`body ${ctx.mark}`)
          ctx.onTestFinished(() => step(`finished ${ctx.mark}`))
          ctx.mark = 'set in body'
        }),
      )
      test(
        'two',
        ctxFn(() => undefined),
      )
      afterEach(ctxFn((ctx: Marked) => step(`afterEach ${ctx.mark}`)))
    }, vitest)
    const keys =
      'keys task:truetruetrue signal:truetruetrue skip:truetruetrue annotate:truetruetrue onTestFinished:truetruetrue onTestFailed:truetruetrue'
    assert.equal(run.states.one, 'pass')
    assert.deepEqual(run.trace, [
      keys,
      'mark before undefined',
      'body set in beforeEach',
      'afterEach set in body',
      'finished set in body',
      // The next test's context is a new object: nothing written to the first one is on it.
      keys,
      'mark before undefined',
      'afterEach set in beforeEach',
    ])
  })

  // The Jest dialect's surface (`done-if-arity`) hands no function a context, so the keys'
  // attributes can't change a Jest outcome: its `done` is its own function, and `this` is a
  // null-prototype object. Recorded: `runtime/context-shape` and `runtime/done-callback`.
  test('under done-if-arity no hook or body is handed a context, and `done` is not one', async () => {
    const jest = {
      firstArg: 'done-if-arity',
      errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' },
    } as const
    const run = await runScript(({ test, beforeEach, afterEach }, step) => {
      beforeEach(((...args: unknown[]) => step(`beforeEach ${args.length}`)) as never)
      test('plain', ((...args: unknown[]) => step(`body ${args.length}`)) as never)
      test('done', ((done: () => void) => {
        step(`done ${typeof done} task:${'task' in done} signal:${'signal' in done}`)
        done()
      }) as never)
      afterEach(function (this: object) {
        step(`afterEach this ${Object.getPrototypeOf(this) === null}`)
      })
    }, jest)
    assert.deepEqual(run.states, { plain: 'pass', done: 'pass' })
    assert.deepEqual(run.trace, [
      'beforeEach 0',
      'body 0',
      'afterEach this true',
      'beforeEach 0',
      'done function task:false signal:false',
      'afterEach this true',
    ])
  })
})
