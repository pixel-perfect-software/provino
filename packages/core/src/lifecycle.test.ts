// The lifecycle events (T8.5's rest, B23d): what an environment's `onTestEvent` sees, in jest-circus
// 30.5.2's order (`run.ts`, `jestAdapterInit.ts`). `@provino/dialect-jest`'s mirror and `provino`'s
// `jest-environments.test.ts` hold the order to a recording of the real events (`env/handle-test-event*`).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LifecycleEvent, LifecycleListener } from '@provino/types'
import { runScript, type Script } from './internal/test-support.ts'

interface Seen {
  readonly line: string
  readonly event: LifecycleEvent
}

/** One line per event: its type, and the name of what it is about. */
function describeEvent(event: LifecycleEvent): string {
  switch (event.type) {
    case 'file-setup':
    case 'file-teardown':
    case 'run-start':
    case 'run-end':
      return event.type
    case 'define-hook':
      return `${event.type} ${event.kind} in ${event.owner.name}`
    case 'hook-start':
    case 'hook-end':
      return `${event.type} ${event.kind}${event.test === undefined ? '' : ` of ${event.test.name}`}${
        event.type === 'hook-end' && event.failed ? ' failed' : ''
      }`
    case 'concurrent-start':
    case 'concurrent-end':
      return `${event.type} ${event.tests.map((ref) => ref.name).join(',')}`
    case 'fn-end':
      return `${event.type} ${event.ref.name}${event.failed ? ' failed' : ''}`
    default:
      return `${event.type} ${event.ref.name}`
  }
}

async function record(script: Script, overrides = {}): Promise<readonly string[]> {
  const seen: Seen[] = []
  const lifecycle: LifecycleListener = (event) => {
    seen.push({ line: describeEvent(event), event })
  }
  await runScript(script, overrides, { lifecycle })
  return seen.map((entry) => entry.line)
}

describe('lifecycle events', () => {
  test('definitions come as the file registers them, then the run, in circus order', async () => {
    const lines = await record(({ describe, test, beforeAll, afterEach }) => {
      beforeAll(() => {})
      describe('block', () => {
        afterEach(() => {})
        test('a', () => {})
        test.skip('b', () => {})
        test.todo('c')
      })
    })
    assert.deepEqual(lines, [
      'file-setup',
      'define-hook beforeAll in script.test.ts',
      'define-suite-start block',
      'define-hook afterEach in block',
      'define-test a',
      'define-test b',
      'define-test c',
      'define-suite-end block',
      'run-start',
      'suite-start script.test.ts',
      'hook-start beforeAll',
      'hook-end beforeAll',
      'suite-start block',
      'test-start a',
      'test-started a',
      'fn-start a',
      'fn-end a',
      'hook-start afterEach of a',
      'hook-end afterEach of a',
      'test-done a',
      'test-start b',
      'test-skip b',
      'test-start c',
      'test-todo c',
      'suite-end block',
      'suite-end script.test.ts',
      'run-end',
      'file-teardown',
    ])
  })

  test('a failing beforeEach: the body does not run, but fn-start, afterEach and test-done still come', async () => {
    const lines = await record(({ test, beforeEach, afterEach }) => {
      beforeEach(() => {
        throw new Error('hook boom')
      })
      afterEach(() => {})
      test('a', () => {})
    })
    const run = lines.slice(lines.indexOf('run-start'))
    assert.deepEqual(run, [
      'run-start',
      'suite-start script.test.ts',
      'test-start a',
      'test-started a',
      'hook-start beforeEach of a',
      'hook-end beforeEach of a failed',
      'fn-start a',
      'hook-start afterEach of a',
      'hook-end afterEach of a',
      'test-done a',
      'suite-end script.test.ts',
      'run-end',
      'file-teardown',
    ])
  })

  test('a failing body: fn-end carries the error; test-done carries every error of the attempt', async () => {
    const seen: LifecycleEvent[] = []
    await runScript(
      ({ test }) => {
        test('a', () => {
          throw new Error('boom')
        })
      },
      {},
      { lifecycle: (event) => void seen.push(event) },
    )
    const end = seen.find((event) => event.type === 'fn-end')
    assert.ok(end?.type === 'fn-end' && end.failed)
    assert.equal((end.error as Error).message, 'boom')
    const done = seen.find((event) => event.type === 'test-done')
    assert.ok(done?.type === 'test-done')
    assert.deepEqual(
      done.errors.map((error) => (error as Error).message),
      ['boom'],
    )
  })

  test('a retried test starts again per attempt, with test-retry between (setDefaultRetry)', async () => {
    const seen: string[] = []
    await runScript(
      ({ test }, _step, runtime) => {
        runtime.setDefaultRetry({ count: 1, delay: 0 })
        let calls = 0
        test('flaky', () => {
          if (++calls === 1) throw new Error('first')
        })
        test('other', () => {})
      },
      { retry: { timing: 'deferred' } },
      { lifecycle: (event) => void seen.push(describeEvent(event)) },
    )
    const run = seen.filter((line) => /^test-(start|retry|done) /.test(line))
    assert.deepEqual(run, [
      'test-start flaky',
      'test-done flaky',
      'test-start other',
      'test-done other',
      'test-retry flaky',
      'test-start flaky',
      'test-done flaky',
    ])
  })

  test('a describe retry: suite-end, suite-retry, then the block again with its suite-start', async () => {
    const lines = await record(({ describe, test }, _step, runtime) => {
      describe('block', () => {
        runtime.setDescribeRetry({ numRetries: 1 })
        let calls = 0
        test('flaky', () => {
          if (++calls === 1) throw new Error('first')
        })
      })
    })
    const block = lines.filter((line) => /^suite-(start|end|retry) block/.test(line))
    assert.deepEqual(block, [
      'suite-start block',
      'suite-end block',
      'suite-retry block',
      'suite-start block',
      'suite-end block',
    ])
  })

  test('a concurrent group is bracketed by concurrent-start and concurrent-end with its tests', async () => {
    const lines = await record(({ test }) => {
      test.concurrent('a', () => {})
      test.concurrent('b', () => {})
    })
    assert.equal(
      lines.filter((line) => line.startsWith('concurrent-')).join('|'),
      ['concurrent-start a,b', 'concurrent-end a,b'].join('|'),
    )
    assert.ok(lines.indexOf('concurrent-start a,b') < lines.indexOf('test-start a'))
    assert.ok(lines.indexOf('concurrent-end a,b') > lines.lastIndexOf('test-done b'))
  })

  test('the run waits for an async listener at each run event, not at a definition', async () => {
    const order: string[] = []
    await runScript(
      ({ test }, step) => {
        test('a', () => step('body'))
      },
      {},
      {
        lifecycle: async (event) => {
          if (event.type === 'define-test') {
            order.push('define')
            await new Promise((resolve) => setTimeout(resolve, 5))
            order.push('define end')
            return
          }
          if (event.type === 'fn-start') {
            await new Promise((resolve) => setTimeout(resolve, 5))
            order.push('fn-start end')
          }
          if (event.type === 'test-done') order.push('done')
        },
      },
    )
    // The definition's promise is not awaited: its end comes while the run goes on.
    assert.equal(order[0], 'define')
    assert.ok(order.indexOf('fn-start end') < order.indexOf('done'))
    assert.ok(order.includes('define end'))
  })

  test('a listener that throws at a run event fails the file', async () => {
    const run = await runScript(
      ({ test }) => {
        test('a', () => {})
      },
      {},
      {
        lifecycle: (event) => {
          if (event.type === 'test-started') throw new Error('handler boom')
        },
      },
    )
    assert.equal(run.file.state, 'fail')
    assert.ok(run.file.errors.some((error) => error.message === 'handler boom'))
  })

  // jest-circus dispatches `hook_success` and `test_fn_success` inside the `try` of
  // `_callCircusHook`/`_callCircusTest` (`run.ts` L467-L481, L497-L519): a throw there is that hook's
  // or body's failure, re-dispatched as `hook_failure`/`test_fn_failure`, and the file goes on.
  test("a listener that throws at a passing hook's hook-end fails that hook; the file goes on", async () => {
    const seen: string[] = []
    const run = await runScript(
      ({ test, beforeEach }) => {
        beforeEach(() => {})
        test('a', () => {})
        test('b', () => {})
      },
      {},
      {
        lifecycle: (event) => {
          seen.push(describeEvent(event))
          if (event.type === 'hook-end' && event.test?.name === 'a' && !event.failed) {
            throw new Error('handler boom')
          }
        },
      },
    )
    assert.deepEqual(run.errors.a, ['handler boom'])
    assert.equal(run.states.b, 'pass')
    assert.equal(run.file.errors.length, 0)
    const a = seen.slice(seen.indexOf('test-start a'), seen.indexOf('test-done a') + 1)
    assert.deepEqual(a, [
      'test-start a',
      'test-started a',
      'hook-start beforeEach of a',
      'hook-end beforeEach of a',
      'hook-end beforeEach of a failed',
      'fn-start a',
      'test-done a',
    ])
  })

  test("a listener that throws at a passing body's fn-end fails that body; the file goes on", async () => {
    const seen: LifecycleEvent[] = []
    const run = await runScript(
      ({ test }) => {
        test('a', () => {})
        test('b', () => {})
      },
      {},
      {
        lifecycle: (event) => {
          seen.push(event)
          if (event.type === 'fn-end' && event.ref.name === 'a' && !event.failed) {
            throw new Error('handler boom')
          }
        },
      },
    )
    assert.deepEqual(run.errors.a, ['handler boom'])
    assert.equal(run.states.b, 'pass')
    const ends = seen.filter((event) => event.type === 'fn-end' && event.ref.name === 'a')
    assert.deepEqual(
      ends.map(
        (event) => event.type === 'fn-end' && [event.failed, (event.error as Error)?.message],
      ),
      [
        [false, undefined],
        [true, 'handler boom'],
      ],
    )
  })

  test('a listener that throws at the fn-end of a body that threw ends the file', async () => {
    const seen: string[] = []
    const run = await runScript(
      ({ test }) => {
        test('a', () => {
          throw new Error('body boom')
        })
        test('b', () => {})
      },
      {},
      {
        lifecycle: (event) => {
          seen.push(describeEvent(event))
          if (event.type === 'fn-end') throw new Error('handler boom')
        },
      },
    )
    assert.equal(run.file.state, 'fail')
    assert.ok(run.file.errors.some((error) => error.message === 'handler boom'))
    assert.equal(seen.at(-1), 'fn-end a failed')
  })

  // Any other dispatch throws out of `_runTestsForDescribeBlockOnce`, which has no `finally`: no
  // `afterAll` runs, and the handler hears nothing more (no `run_finish`, no `teardown`).
  test('a listener that throws at any other run event ends the file: no afterAll, no more events', async () => {
    const seen: string[] = []
    const run = await runScript(
      ({ describe, test, afterAll, afterEach }, step) => {
        afterAll(() => step('afterAll root'))
        describe('block', () => {
          afterEach(() => step('afterEach block'))
          afterAll(() => step('afterAll block'))
          test('a', () => step('a'))
          test('b', () => step('b'))
        })
      },
      {},
      {
        lifecycle: (event) => {
          seen.push(describeEvent(event))
          if (event.type === 'test-start' && event.ref.name === 'b') throw new Error('handler boom')
        },
      },
    )
    assert.deepEqual(run.trace, ['a', 'afterEach block'])
    assert.equal(seen.at(-1), 'test-start b')
    assert.equal(run.file.state, 'fail')
    assert.ok(run.file.errors.some((error) => error.message === 'handler boom'))
  })

  test('a throw at a failed hook-end ends the file too (circus dispatches hook_failure in the catch)', async () => {
    const seen: string[] = []
    const run = await runScript(
      ({ test, beforeEach }, step) => {
        beforeEach(() => {
          throw new Error('hook boom')
        })
        test('a', () => step('a'))
        test('b', () => step('b'))
      },
      {},
      {
        lifecycle: (event) => {
          seen.push(describeEvent(event))
          if (event.type === 'hook-end' && event.failed) throw new Error('handler boom')
        },
      },
    )
    assert.equal(seen.at(-1), 'hook-end beforeEach of a failed')
    assert.equal(run.file.state, 'fail')
    assert.ok(run.file.errors.some((error) => error.message === 'handler boom'))
  })

  test('a throw in a concurrent group ends the file once every test of the group has ended', async () => {
    const seen: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = await runScript(
      ({ test }, step) => {
        test.concurrent('a', async () => {
          await gate
          step('a done')
        })
        test.concurrent('b', () => step('b'))
        test('after', () => step('after'))
      },
      {},
      {
        lifecycle: (event) => {
          seen.push(describeEvent(event))
          if (event.type === 'test-started' && event.ref.name === 'b') {
            // `a` is still waiting: it ends only after the throw.
            release()
            throw new Error('handler boom')
          }
        },
      },
    )
    assert.equal(seen.at(-1), 'test-started b')
    assert.ok(run.trace.includes('a done'), 'the running sibling finished before the file ended')
    assert.ok(!run.trace.includes('after'))
    const fileEnd = run.events.findIndex((event) => event.type === 'file-end')
    assert.equal(fileEnd, run.events.length - 1, 'nothing of the file comes after its file-end')
    assert.equal(run.file.state, 'fail')
  })

  // `LazyHost.addHook` (eager lazy values) adds hooks no test file declared: circus has no such
  // hook, so the listener never hears of it, and the declared hooks keep their own events.
  test('a hook LazyHost.addHook appended is not a lifecycle hook and shifts no declared hook', async () => {
    const seen: string[] = []
    const run = await runScript(
      ({ test, beforeEach }, step, runtime) => {
        beforeEach(() => step('a'))
        const suite = runtime.lazyHost.collecting()
        assert.ok(suite !== undefined)
        runtime.lazyHost.addHook(suite, 'beforeEach', () => step('lazy'))
        beforeEach(() => {
          throw new Error('b boom')
        })
        test('t', () => {})
      },
      {},
      { lifecycle: (event) => void seen.push(describeEvent(event)) },
    )
    assert.deepEqual(run.trace, ['a', 'lazy'])
    assert.deepEqual(
      seen.filter((line) => line.startsWith('hook-') || line.startsWith('define-hook')),
      [
        'define-hook beforeEach in script.test.ts',
        'define-hook beforeEach in script.test.ts',
        'hook-start beforeEach of t',
        'hook-end beforeEach of t',
        'hook-start beforeEach of t',
        'hook-end beforeEach of t failed',
      ],
    )
  })

  test('a collection failure still tears down nothing: no file-teardown for a file that did not collect', async () => {
    const seen: string[] = []
    await runScript(
      () => {
        throw new Error('import failed')
      },
      {},
      { lifecycle: (event) => void seen.push(event.type) },
    )
    assert.deepEqual(seen, ['file-setup'])
  })

  test('a lifecycle that is not a function fails the file before it is imported', async () => {
    const run = await runScript(
      () => {},
      {},
      {
        // @ts-expect-error wrong type on purpose: `FileJob` crosses a link unvalidated
        lifecycle: 'nope',
      },
    )
    assert.equal(run.file.state, 'fail')
    assert.match(run.file.errors[0]?.message ?? '', /lifecycle/)
  })
})
