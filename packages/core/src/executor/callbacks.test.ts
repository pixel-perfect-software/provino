// `onTestFinished` and `onTestFailed`: the order they run in, ctx and global forms, and where they
// may be called from.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { TestContext } from '@provino/types'
import { eventLog, runScript, type Script, type ScriptRun } from '../internal/test-support.ts'

/** The code of the first error of a test. */
const codeOf = (run: ScriptRun, name: string): string | undefined =>
  run.results[name]?.errors[0]?.code

describe('onTestFinished', () => {
  test('runs after a passing test and after a failing one', async () => {
    const run = await runScript(({ test, onTestFinished }, step) => {
      test('passes', () => onTestFinished(() => step('finished: passes')))
      test('fails', () => {
        onTestFinished(() => step('finished: fails'))
        throw new Error('boom')
      })
    })
    assert.deepEqual(run.trace, ['finished: passes', 'finished: fails'])
    assert.deepEqual(run.states, { passes: 'pass', fails: 'fail' })
  })

  test('runs the callbacks last registered first', async () => {
    const run = await runScript(({ test, onTestFinished }, step) => {
      test('t', () => {
        onTestFinished(() => step('first'))
        onTestFinished(() => step('second'))
        onTestFinished(() => step('third'))
      })
    })
    assert.deepEqual(run.trace, ['third', 'second', 'first'])
  })

  test('the ctx form and the global form share one list', async () => {
    const run = await runScript(({ test, onTestFinished }, step) => {
      test('t', (ctx) => {
        ctx.onTestFinished(() => step('ctx first'))
        onTestFinished(() => step('global second'))
        ctx.onTestFinished(() => step('ctx third'))
      })
    })
    assert.deepEqual(run.trace, ['ctx third', 'global second', 'ctx first'])
  })

  test('hands the callback the test context', async () => {
    let seen: TestContext | undefined
    let body: TestContext | undefined
    await runScript(({ test }) => {
      test('t', (ctx) => {
        body = ctx
        ctx.onTestFinished((given) => {
          seen = given
        })
      })
    })
    assert.equal(seen, body)
  })

  test('a global call from a beforeEach registers for the test about to run', async () => {
    const run = await runScript(({ test, beforeEach, onTestFinished }, step) => {
      beforeEach(() => {
        onTestFinished(() => step('finished from hook'))
      })
      test('t', () => step('body'))
    })
    assert.deepEqual(run.trace, ['body', 'finished from hook'])
  })

  test('a global call attaches to its own test while concurrent tests interleave', async () => {
    const gate = Promise.withResolvers<void>()
    const run = await runScript(({ test, onTestFinished }, step) => {
      test.concurrent('a', async () => {
        await gate.promise
        onTestFinished((ctx) => step(`finished for ${ctx.task.name}`))
      })
      test.concurrent('b', () => {
        onTestFinished((ctx) => step(`finished for ${ctx.task.name}`))
        gate.resolve()
      })
    })
    assert.deepEqual([...run.trace].sort(), ['finished for a', 'finished for b'])
  })

  test('a callback that throws fails a test whose body passed', async () => {
    const run = await runScript(({ test, onTestFinished }) => {
      test('t', () => {
        onTestFinished(() => {
          throw new Error('callback failed')
        })
      })
    })
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.errors.t, ['callback failed'])
  })

  test('a callback may be async', async () => {
    const run = await runScript(({ test, onTestFinished }, step) => {
      test('t', () => {
        onTestFinished(async () => {
          await Promise.resolve()
          step('after await')
        })
      })
    })
    assert.deepEqual(run.trace, ['after await'])
  })
})

describe('onTestFailed', () => {
  test('runs only for a test that failed', async () => {
    const run = await runScript(({ test, onTestFailed }, step) => {
      test('passes', () => onTestFailed(() => step('failed: passes')))
      test('fails', () => {
        onTestFailed(() => step('failed: fails'))
        throw new Error('boom')
      })
    })
    assert.deepEqual(run.trace, ['failed: fails'])
  })

  test('runs for a test that failed in an afterEach hook', async () => {
    const run = await runScript(({ test, afterEach, onTestFailed }, step) => {
      afterEach(() => {
        throw new Error('afterEach failed')
      })
      test('t', () => onTestFailed(() => step('failed')))
    })
    assert.deepEqual(run.trace, ['failed'])
  })

  const three: Script = ({ test }, step) => {
    test('t', (ctx) => {
      ctx.onTestFailed(() => step('first'))
      ctx.onTestFailed(() => step('second'))
      ctx.onTestFailed(() => step('third'))
      throw new Error('boom')
    })
  }

  test('runs in the order of hookOrder.afterEach: reverse runs the last registered first', async () => {
    const run = await runScript(three, { hookOrder: { afterEach: 'reverse' } })
    assert.deepEqual(run.trace, ['third', 'second', 'first'])
  })

  test('runs in the order of hookOrder.afterEach: declaration runs them as registered', async () => {
    const run = await runScript(three, { hookOrder: { afterEach: 'declaration' } })
    assert.deepEqual(run.trace, ['first', 'second', 'third'])
  })

  test('a callback that throws adds its error to the test', async () => {
    const run = await runScript(({ test, onTestFailed }) => {
      test('t', () => {
        onTestFailed(() => {
          throw new Error('callback failed')
        })
        throw new Error('body failed')
      })
    })
    assert.deepEqual(run.errors.t, ['body failed', 'callback failed'])
  })
})

describe('what runs after the body', () => {
  test('afterEach, then returned cleanups, then lazy teardowns, then onTestFinished, then onTestFailed', async () => {
    const run = await runScript(({ test, beforeEach, afterEach }, step, runtime) => {
      beforeEach(() => () => step('cleanup'))
      afterEach(() => step('afterEach'))
      test('t', (ctx) => {
        step('body')
        ctx.onTestFailed(() => step('failed'))
        ctx.onTestFinished(() => step('finished'))
        const frame = runtime.lazyHost.current()
        assert.equal(frame?.kind, 'test')
        if (frame?.kind === 'test') frame.run.addTeardown(() => step('lazy teardown'))
        throw new Error('boom')
      })
    })
    assert.deepEqual(run.trace, [
      'body',
      'afterEach',
      'cleanup',
      'lazy teardown',
      'finished',
      'failed',
    ])
  })

  test('each callback is reported as a hook of its kind, owned by the suite of the test', async () => {
    const run = await runScript(({ describe, test, onTestFinished, onTestFailed }) => {
      describe('a', () => {
        test('t', () => {
          onTestFinished(() => {})
          onTestFinished(() => {})
          onTestFailed(() => {})
          throw new Error('boom')
        })
      })
    })
    assert.deepEqual(
      eventLog(run).filter((line) => line.startsWith('hook-start')),
      [
        'hook-start onTestFinished#0 owner=a test=a > t',
        'hook-start onTestFinished#1 owner=a test=a > t',
        'hook-start onTestFailed#0 owner=a test=a > t',
      ],
    )
  })
})

describe('where the callbacks can be called', () => {
  test('a global onTestFinished at the top of a file fails the file with CORE_TEST_CALLBACK_CONTEXT', async () => {
    const run = await runScript(({ onTestFinished }) => {
      onTestFinished(() => {})
    })
    assert.equal(run.file.state, 'fail')
    assert.equal(run.file.errors[0]?.code, 'CORE_TEST_CALLBACK_CONTEXT')
  })

  test('a global onTestFailed in a beforeAll fails the tests below with CORE_TEST_CALLBACK_CONTEXT', async () => {
    const run = await runScript(({ test, beforeAll, onTestFailed }) => {
      beforeAll(() => onTestFailed(() => {}))
      test('t', () => {})
    })
    assert.equal(codeOf(run, 't'), 'CORE_TEST_CALLBACK_CONTEXT')
  })

  test('a global call after the file has run throws CORE_TEST_CALLBACK_CONTEXT', async () => {
    const run = await runScript(({ test }) => {
      test('t', () => {})
    })
    assert.throws(() => run.runtime.api.onTestFinished(() => {}), {
      code: 'CORE_TEST_CALLBACK_CONTEXT',
    })
    assert.throws(() => run.runtime.api.onTestFailed(() => {}), {
      code: 'CORE_TEST_CALLBACK_CONTEXT',
    })
  })

  test('a call from inside an onTestFinished callback fails the test with CORE_TEST_CALLBACK_CONTEXT', async () => {
    const run = await runScript(({ test, onTestFinished }) => {
      test('t', () => {
        onTestFinished(() => {
          onTestFinished(() => {})
        })
      })
    })
    assert.equal(run.states.t, 'fail')
    assert.equal(codeOf(run, 't'), 'CORE_TEST_CALLBACK_CONTEXT')
  })

  test('a ctx call from inside an onTestFailed callback fails the test with CORE_TEST_CALLBACK_CONTEXT', async () => {
    const run = await runScript(({ test, onTestFailed }) => {
      test('t', (ctx) => {
        onTestFailed(() => ctx.onTestFinished(() => {}))
        throw new Error('boom')
      })
    })
    assert.ok(run.results.t?.errors.some((error) => error.code === 'CORE_TEST_CALLBACK_CONTEXT'))
  })

  test('a callback that is not a function throws CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ test, onTestFinished }) => {
      test('t', () => {
        onTestFinished('nope' as never)
      })
    })
    assert.equal(codeOf(run, 't'), 'CORE_INVALID_ARGUMENT')
  })
})
