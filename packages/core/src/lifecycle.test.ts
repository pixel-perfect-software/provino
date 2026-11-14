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
        runtime.setDefaultRetry({ count: 1 })
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
