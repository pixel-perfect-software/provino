// T5.10's rest: the retry of a whole describe block (`Runtime.setDescribeRetry`, Jest's
// `jest.retryTimes(n, { entireDescribe: true })`). The rules are jest-circus 30.5.2's
// `_runTestsForDescribeBlock` (`run.ts` L104-L177): the block's hooks and every test below run
// again while a test fails, the last attempt's results stand, an error nobody owns ends the retries,
// and a test below gets none of its own retries. `@provino/harness`'s `runtime/retry-entire-*`
// fixtures hold the recorded order.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import type { DescribeRetry, ShuffleFactory } from '@provino/types'
import FakeTimers from '@sinonjs/fake-timers'
import {
  clockOptions,
  eventLog,
  eventsOf,
  runScript,
  type Script,
} from '../internal/test-support.ts'

/** Errors raised outside a running test are charged to the test whose context raised them. */
const owner = { errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' } } as const

/** A test that fails its first `failures` calls, tracing each call as `<name>#<call>`. */
function flaky(
  api: Parameters<Script>[0],
  step: (name: string) => void,
  name: string,
  failures: number,
): void {
  let calls = 0
  api.test(name, () => {
    calls++
    step(`${name}#${calls}`)
    if (calls <= failures) throw new Error(`${name} fail ${calls}`)
  })
}

const retry = (numRetries: number, rest: Partial<DescribeRetry> = {}): DescribeRetry => ({
  numRetries,
  ...rest,
})

describe('describe retry', () => {
  test('the block runs again, hooks and every test, until no test fails', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('block', () => {
        assert.equal(runtime.setDescribeRetry(retry(2)), 'set')
        const api = runtime.api
        api.beforeAll(() => step('beforeAll'))
        api.beforeEach(() => step('beforeEach'))
        api.afterEach(() => step('afterEach'))
        api.afterAll(() => step('afterAll'))
        flaky(api, step, 'a', 1)
        api.test('b', () => step('b'))
      })
    })
    assert.deepEqual(run.trace, [
      'beforeAll',
      'beforeEach',
      'a#1',
      'afterEach',
      'beforeEach',
      'b',
      'afterEach',
      'afterAll',
      'beforeAll',
      'beforeEach',
      'a#2',
      'afterEach',
      'beforeEach',
      'b',
      'afterEach',
      'afterAll',
    ])
    assert.deepEqual(run.states, { 'block > a': 'pass', 'block > b': 'pass' })
    assert.equal(run.file.state, 'pass')
  })

  test('the events show each task start once, one attempt per describe attempt (a dropped one as retried), and one end', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('block', () => {
        runtime.setDescribeRetry(retry(1))
        flaky(runtime.api, step, 'a', 1)
      })
    })
    assert.deepEqual(
      eventLog(run).filter((line) => !line.startsWith('hook')),
      [
        'file-collect-start',
        'file-collect-end',
        'suite-start block',
        'test-start block > a',
        'attempt-start block > a 0/0',
        'attempt-end block > a 0/0 fail will-retry',
        'attempt-start block > a 1/0',
        'attempt-end block > a 1/0 pass',
        'test-end block > a pass',
        'suite-end block pass',
        'file-end',
      ],
    )
    assert.equal(run.results['block > a']?.attempts, 2)
  })

  test('the last attempt stands when every attempt fails, and the count is the retries', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('block', () => {
        runtime.setDescribeRetry(retry(2))
        flaky(runtime.api, step, 'a', 99)
      })
    })
    assert.deepEqual(run.trace, ['a#1', 'a#2', 'a#3'])
    assert.deepEqual(run.errors['block > a'], ['a fail 3'])
    assert.equal(run.states['block > a'], 'fail')
    assert.equal(run.suites.block?.state, 'fail')
  })

  test('a block with a retry of 0 runs once', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('block', () => {
        runtime.setDescribeRetry(retry(0))
        flaky(runtime.api, step, 'a', 99)
      })
    })
    assert.deepEqual(run.trace, ['a#1'])
  })

  test('a describe at the top of the file retries the whole file', async () => {
    const run = await runScript((api, step, runtime) => {
      runtime.setDescribeRetry(retry(1))
      api.beforeAll(() => step('beforeAll'))
      flaky(api, step, 'a', 1)
      api.describe('inner', () => api.test('b', () => step('b')))
    })
    assert.deepEqual(run.trace, ['beforeAll', 'a#1', 'b', 'beforeAll', 'a#2', 'b'])
    assert.deepEqual(run.states, { a: 'pass', 'inner > b': 'pass' })
  })

  test('a nested block with its own retry retries inside each attempt of the outer one', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('outer', () => {
        runtime.setDescribeRetry(retry(1))
        describe('inner', () => {
          runtime.setDescribeRetry(retry(1))
          flaky(runtime.api, step, 'a', 2)
        })
        flaky(runtime.api, step, 'b', 1)
      })
    })
    // Outer attempt 1: inner fails once and is retried (a#2 fails), then b fails. Outer attempt 2:
    // inner runs again (a#3 passes), b passes.
    assert.deepEqual(run.trace, ['a#1', 'a#2', 'b#1', 'a#3', 'b#2'])
    assert.deepEqual(run.states, { 'outer > inner > a': 'pass', 'outer > b': 'pass' })
    assert.equal(run.results['outer > inner > a']?.attempts, 3)
  })

  test('a later call for the same block replaces the first', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('block', () => {
        runtime.setDescribeRetry(retry(5))
        runtime.setDescribeRetry(retry(1))
        flaky(runtime.api, step, 'a', 99)
      })
    })
    assert.deepEqual(run.trace, ['a#1', 'a#2'])
  })

  test('a test below gets none of the file default retries', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      runtime.setDefaultRetry({ count: 3, delay: 0 })
      describe('block', () => {
        runtime.setDescribeRetry(retry(1))
        flaky(runtime.api, step, 'a', 99)
      })
      flaky(runtime.api, step, 'outside', 99)
    })
    assert.deepEqual(run.trace, ['a#1', 'a#2', 'outside#1', 'outside#2', 'outside#3', 'outside#4'])
  })

  test('errors of the dropped attempts are kept on the result with logErrorsBeforeRetry', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('block', () => {
        runtime.setDescribeRetry(retry(2, { logErrorsBeforeRetry: true }))
        flaky(runtime.api, step, 'a', 2)
        runtime.api.test('b', () => step('b'))
      })
    })
    assert.deepEqual(
      run.results['block > a']?.retryErrors.map((error) => error.message),
      ['a fail 1', 'a fail 2'],
    )
    assert.deepEqual(run.results['block > b']?.retryErrors, [])
  })

  test('the dropped errors are not kept without logErrorsBeforeRetry', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('block', () => {
        runtime.setDescribeRetry(retry(2))
        flaky(runtime.api, step, 'a', 1)
      })
    })
    assert.deepEqual(run.results['block > a']?.retryErrors, [])
  })

  test('waitBeforeRetry waits before each retry', async () => {
    const clock = FakeTimers.createClock()
    const run = runScript(
      ({ describe }, step, runtime) => {
        describe('block', () => {
          runtime.setDescribeRetry(retry(2, { waitBeforeRetry: 100 }))
          flaky(runtime.api, step, 'a', 2)
        })
      },
      {},
      clockOptions(clock),
    )
    await clock.tickAsync(250)
    const done = await run
    assert.deepEqual(done.trace, ['a#1', 'a#2', 'a#3'])
  })

  test('a failing afterAll ends the retries, as an unhandled error does in jest-circus', async () => {
    const run = await runScript(
      ({ describe }, step, runtime) => {
        describe('block', () => {
          runtime.setDescribeRetry(retry(3))
          runtime.api.afterAll(() => {
            throw new Error('afterAll failed')
          })
          flaky(runtime.api, step, 'a', 99)
        })
      },
      { hooks: { afterAllError: 'unhandled' } },
    )
    assert.deepEqual(run.trace, ['a#1'])
    assert.equal(run.file.state, 'fail')
  })

  test('a block with no failing test is not run again', async () => {
    const run = await runScript(({ describe }, step, runtime) => {
      describe('block', () => {
        runtime.setDescribeRetry(retry(3))
        runtime.api.test('a', () => step('a'))
      })
    })
    assert.deepEqual(run.trace, ['a'])
  })

  test('a shuffle is made once per block: the retried block keeps its order', async () => {
    const calls: number[] = []
    const factory: ShuffleFactory =
      () =>
      <T>(items: T[]): T[] => {
        calls.push(items.length)
        items.reverse()
        return items
      }
    const run = await runScript(
      ({ describe }, step, runtime) => {
        describe('block', () => {
          runtime.setDescribeRetry(retry(1))
          runtime.api.test('a', () => step('a'))
          flaky(runtime.api, step, 'b', 1)
        })
      },
      { shuffle: factory },
      { shuffleSeed: 7 },
    )
    assert.deepEqual(run.trace, ['b#1', 'a', 'b#2', 'a'])
    // The file's children (one block), then the block's.
    assert.deepEqual(calls, [1, 2])
  })

  test('concurrent sibling blocks keep their own attempts, and a test beside one keeps its retries', async () => {
    // `concurrency.grouping: 'consecutive'` runs the three blocks side by side. `b` ends while `a`'s
    // block is still open; `a` fails once and its block runs again. `c` is in no describe retry, so
    // the file default retry is its own.
    let releaseB: () => void = () => {}
    const bDone = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let releaseC: () => void = () => {}
    const cDone = new Promise<void>((resolve) => {
      releaseC = resolve
    })
    let aCalls = 0
    let cCalls = 0
    const run = await runScript(({ describe }, step, runtime) => {
      runtime.setDefaultRetry({ count: 1, delay: 0 })
      describe.concurrent('A', () => {
        runtime.setDescribeRetry(retry(1))
        runtime.api.test('a', async () => {
          aCalls++
          step(`a#${aCalls}`)
          await bDone
          await cDone
          if (aCalls === 1) throw new Error('a fails once')
        })
      })
      describe.concurrent('B', () => {
        runtime.setDescribeRetry(retry(1))
        runtime.api.test('b', () => {
          step('b')
          releaseB()
        })
      })
      describe.concurrent('C', () => {
        runtime.api.test('c', () => {
          cCalls++
          step(`c#${cCalls}`)
          if (cCalls === 1) throw new Error('c fails once')
          releaseC()
        })
      })
    })
    assert.deepEqual(run.states, { 'A > a': 'pass', 'B > b': 'pass', 'C > c': 'pass' })
    assert.equal(run.results['A > a']?.attempts, 2)
    assert.equal(run.results['B > b']?.attempts, 1)
    assert.equal(run.results['C > c']?.attempts, 2, 'c keeps the file default retry')
    const log = eventLog(run)
    for (const task of ['A', 'B', 'C', 'A > a', 'B > b', 'C > c']) {
      const kind = task.includes('>') ? 'test' : 'suite'
      assert.equal(
        log.filter((line) => line.startsWith(`${kind}-start ${task}`)).length,
        1,
        `${task} starts once`,
      )
      assert.equal(
        log.filter((line) => line.startsWith(`${kind}-end ${task} `)).length,
        1,
        `${task} ends once`,
      )
    }
    assert.equal(run.file.state, 'pass')
  })

  test('an error a test had before the attempt (a parent beforeAll) runs the block once', async () => {
    // circus counts only the errors an attempt added (`errorsBeforeAttempt`): the outer error is
    // already on the test, so `runtime/retry-entire-describe-parent-before-all-fails` runs once.
    const run = await runScript(
      ({ describe }, step, runtime) => {
        describe('outer', () => {
          runtime.api.beforeAll(() => {
            throw new Error('outer beforeAll')
          })
          describe('inner', () => {
            runtime.setDescribeRetry(retry(2))
            runtime.api.beforeAll(() => step('inner beforeAll'))
            runtime.api.afterAll(() => step('inner afterAll'))
            runtime.api.test('a', () => step('a'))
          })
        })
      },
      {
        hooks: {
          beforeAllError: 'attach-to-tests',
          nestedHooksAfterBeforeAllError: 'run',
          afterAllError: 'unhandled',
        },
      },
    )
    assert.deepEqual(run.trace, ['inner beforeAll', 'inner afterAll'])
    assert.equal(run.results['outer > inner > a']?.attempts, 1)
    assert.equal(run.states['outer > inner > a'], 'fail')
  })

  test('a beforeAll of the retried block itself that fails is an error the attempt added', async () => {
    let calls = 0
    const run = await runScript(
      ({ describe }, step, runtime) => {
        describe('block', () => {
          runtime.setDescribeRetry(retry(2))
          runtime.api.beforeAll(() => {
            calls++
            step(`beforeAll#${calls}`)
            if (calls === 1) throw new Error('beforeAll fails once')
          })
          runtime.api.test('a', () => step('a'))
        })
      },
      {
        hooks: {
          beforeAllError: 'attach-to-tests',
          nestedHooksAfterBeforeAllError: 'run',
          afterAllError: 'unhandled',
        },
      },
    )
    assert.deepEqual(run.trace, ['beforeAll#1', 'beforeAll#2', 'a'])
    assert.equal(run.states['block > a'], 'pass')
  })

  test('an error charged late to an ended test of the block retries it, and is dropped with the attempt', async () => {
    // circus pushes it to `context.test.errors` (`eventHandler.ts` L308), which the attempt added; it
    // is not an error nobody owns, so it doesn't end the retries.
    const process = new EventEmitter()
    let release: () => void = () => {}
    const late = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const run = await runScript(({ describe }, step, runtime) => {
      runtime.captureProcessErrors(process)
      describe('block', () => {
        runtime.setDescribeRetry(retry(2))
        runtime.api.test('a', () => {
          calls++
          step(`a#${calls}`)
          if (calls === 1) {
            setImmediate(() => {
              process.emit('uncaughtException', new Error('late'), 'uncaughtException')
              release()
            })
          }
        })
        runtime.api.test('b', async () => {
          step('b')
          await late
        })
      })
    }, owner)
    assert.deepEqual(run.trace, ['a#1', 'b', 'a#2', 'b'])
    assert.deepEqual(run.states, { 'block > a': 'pass', 'block > b': 'pass' })
    assert.deepEqual(eventsOf(run.events, 'unhandled-error'), [], 'dropped with its attempt')
    assert.equal(run.file.state, 'pass')
  })

  test('an error charged late to a test of the last attempt stays, and fails the file', async () => {
    const process = new EventEmitter()
    let release: () => void = () => {}
    const late = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = await runScript(({ describe }, step, runtime) => {
      runtime.captureProcessErrors(process)
      describe('block', () => {
        runtime.setDescribeRetry(retry(0, { logErrorsBeforeRetry: true }))
        runtime.api.test('a', () => {
          step('a')
          setImmediate(() => {
            process.emit('uncaughtException', new Error('late'), 'uncaughtException')
            release()
          })
        })
        runtime.api.test('b', () => late)
      })
    }, owner)
    assert.deepEqual(run.trace, ['a'])
    const [event, ...rest] = eventsOf(run.events, 'unhandled-error')
    assert.equal(rest.length, 0)
    assert.equal(event?.error.message, 'late')
    assert.equal(run.file.state, 'fail')
  })

  test('a blocked suite inside a retried block starts each task once', async () => {
    const run = await runScript(
      ({ describe }, _step, runtime) => {
        describe('block', () => {
          runtime.setDescribeRetry(retry(1))
          runtime.api.test.only('a', () => {})
          runtime.api.describe.only('only', () => {
            runtime.api.test('c', () => {})
          })
        })
      },
      {},
      { ci: true },
    )
    const log = eventLog(run)
    for (const line of ['suite-start block', 'test-start block > a', 'suite-start block > only']) {
      assert.equal(log.filter((entry) => entry === line).length, 1, line)
    }
    assert.equal(log.filter((entry) => entry === 'test-start block > only > c').length, 1)
  })

  test('setDescribeRetry says started once no block is being collected', async () => {
    let seen: string | undefined
    await runScript(({ test }, _step, runtime) => {
      test('a', () => {
        seen = runtime.setDescribeRetry(retry(1))
      })
    })
    assert.equal(seen, 'started')
  })
})
