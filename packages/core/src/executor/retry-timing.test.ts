// T5.10: when a retry runs (`retry.timing`), the file's default retry (`setDefaultRetry`, Jest's
// `jest.retryTimes`), a retry's `delay` and `condition`, and the interplay with repeats. The order
// of each case is jest-circus 30.5's `_runTestsForDescribeBlockOnce` (deferred) and Vitest 5.0's
// `runTest` (immediate); `@provino/harness`'s runtime corpus (`runtime/retry-*`) holds the
// recorded ground truth.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DefaultRetry } from '@provino/types'
import FakeTimers from '@sinonjs/fake-timers'
import type { RetryOption } from '../collector/retry.ts'
import {
  clockOptions,
  eventLog,
  reached,
  runScript,
  type Script,
  watch,
} from '../internal/test-support.ts'

const DEFERRED = { retry: { timing: 'deferred' } } as const

/** Jest's `jest.retryTimes(count)` with no options. */
const retryTimes = (count: number, rest: Partial<DefaultRetry> = {}): DefaultRetry => ({
  count,
  delay: 0,
  immediate: false,
  logErrors: false,
  ...rest,
})

/** A test that fails its first `failures` calls, tracing each call as `<name>#<call>`. */
function flaky(
  api: Parameters<Script>[0],
  step: (name: string) => void,
  name: string,
  failures: number,
  options: { retry?: number } = {},
): void {
  let calls = 0
  api.test(name, options, () => {
    calls++
    step(`${name}#${calls}`)
    if (calls <= failures) throw new Error(`${name} fail ${calls}`)
  })
}

describe('deferred retries (retry.timing: deferred)', () => {
  test('a failed test is retried after the rest of its describe, in the order they failed', async () => {
    const run = await runScript((api, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(2))
      flaky(api, step, 'a', 1)
      api.test('b', () => step('b'))
      flaky(api, step, 'c', 2)
      api.test('d', () => step('d'))
    }, DEFERRED)
    assert.deepEqual(run.trace, ['a#1', 'b', 'c#1', 'd', 'a#2', 'c#2', 'c#3'])
    assert.deepEqual(run.states, { a: 'pass', b: 'pass', c: 'pass', d: 'pass' })
  })

  test('a nested describe retries its own tests at its own end; the file level retries at the file end', async () => {
    const run = await runScript(({ describe, test }, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(1))
      let outer = 0
      let inner = 0
      test('outer', () => {
        step(`outer#${++outer}`)
        if (outer === 1) throw new Error('outer fails once')
      })
      describe('d', () => {
        test('inner', () => {
          step(`inner#${++inner}`)
          if (inner === 1) throw new Error('inner fails once')
        })
        test('inner sibling', () => step('inner sibling'))
      })
      test('last', () => step('last'))
    }, DEFERRED)
    assert.deepEqual(run.trace, [
      'outer#1',
      'inner#1',
      'inner sibling',
      'inner#2',
      'last',
      'outer#2',
    ])
  })

  test('a test is one test-start to one test-end; the attempts in between name the retry', async () => {
    const run = await runScript((api, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(1))
      flaky(api, step, 'a', 1)
      api.test('b', () => step('b'))
    }, DEFERRED)
    const lines = eventLog(run).filter((line) => /^(test-|attempt-)/.test(line))
    assert.deepEqual(lines, [
      'test-start a',
      'attempt-start a 0/0',
      'attempt-end a 0/0 fail will-retry',
      'test-start b',
      'attempt-start b 0/0',
      'attempt-end b 0/0 pass',
      'test-end b pass',
      'attempt-start a 1/0',
      'attempt-end a 1/0 pass',
      'test-end a pass',
    ])
    assert.equal(run.results.a?.attempts, 2)
  })

  test('the retry runs the each-hooks again, and the suite hooks once: afterAll waits for the retries', async () => {
    const run = await runScript(
      ({ beforeAll, afterAll, beforeEach, afterEach, test }, step, runtime) => {
        runtime.setDefaultRetry(retryTimes(1))
        let calls = 0
        beforeAll(() => step('beforeAll'))
        afterAll(() => step('afterAll'))
        beforeEach(() => step('beforeEach'))
        afterEach(() => step('afterEach'))
        test('a', () => {
          step('a')
          if (++calls === 1) throw new Error('first attempt fails')
        })
        test('b', () => step('b'))
      },
      DEFERRED,
    )
    assert.deepEqual(run.trace, [
      'beforeAll',
      'beforeEach',
      'a',
      'afterEach',
      'beforeEach',
      'b',
      'afterEach',
      'beforeEach',
      'a',
      'afterEach',
      'afterAll',
    ])
  })

  test('a describe is not over until its retries are: its result is the retried tests final outcome', async () => {
    const run = await runScript(({ describe, test }, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(1))
      describe('d', () => {
        let calls = 0
        test('flaky', () => {
          step(`flaky#${++calls}`)
          if (calls === 1) throw new Error('fails once')
        })
      })
    }, DEFERRED)
    assert.equal(run.states['d > flaky'], 'pass')
    assert.equal(run.suites.d?.state, 'pass')
    const log = eventLog(run)
    assert.ok(log.indexOf('test-end d > flaky pass') < log.indexOf('suite-end d pass'))
  })

  test('a test that fails every attempt fails with the last attempts error', async () => {
    const run = await runScript((api, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(2))
      flaky(api, step, 'bad', 10)
    }, DEFERRED)
    assert.deepEqual(run.trace, ['bad#1', 'bad#2', 'bad#3'])
    assert.equal(run.states.bad, 'fail')
    assert.deepEqual(run.errors.bad, ['bad fail 3'])
    assert.equal(run.results.bad?.attempts, 3)
  })

  test('concurrent tests retry after the group, one at a time', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(1))
      const calls: Record<string, number> = { a: 0, b: 0 }
      for (const name of ['a', 'b']) {
        test.concurrent(name, async () => {
          calls[name] = (calls[name] ?? 0) + 1
          step(`${name}#${calls[name]} start`)
          await Promise.resolve()
          step(`${name}#${calls[name]} end`)
          if (calls[name] === 1) throw new Error(`${name} fails once`)
        })
      }
    }, DEFERRED)
    assert.deepEqual(run.trace, [
      'a#1 start',
      'b#1 start',
      'a#1 end',
      'b#1 end',
      'a#2 start',
      'a#2 end',
      'b#2 start',
      'b#2 end',
    ])
  })

  test('with repeats, a failed test retries at once: neither runner combines the two', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(1))
      let calls = 0
      test('r', { repeats: 1 }, () => {
        step(`r#${++calls}`)
        if (calls === 1) throw new Error('first call fails')
      })
      test('next', () => step('next'))
    }, DEFERRED)
    assert.deepEqual(run.trace, ['r#1', 'r#2', 'r#3', 'next'])
  })

  test('a test that skips itself is not retried', async () => {
    const run = await runScript(
      ({ test }, step, runtime) => {
        runtime.setDefaultRetry(retryTimes(2))
        test('skipper', (ctx) => {
          step('skipper')
          ctx.skip('not here')
        })
      },
      { ...DEFERRED, firstArg: 'context' },
    )
    assert.deepEqual(run.trace, ['skipper'])
    assert.equal(run.states.skipper, 'skip')
  })
})

describe('retry.timing: immediate with a file default', () => {
  test('retries follow the failed attempt at once', async () => {
    const run = await runScript(
      (api, step, runtime) => {
        runtime.setDefaultRetry(retryTimes(2))
        flaky(api, step, 'a', 1)
        api.test('b', () => step('b'))
      },
      { retry: { timing: 'immediate' } },
    )
    assert.deepEqual(run.trace, ['a#1', 'a#2', 'b'])
  })
})

describe('setDefaultRetry (jest.retryTimes)', () => {
  test('`immediate` retries at once under a deferred policy (retryImmediately)', async () => {
    const run = await runScript((api, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(2, { immediate: true }))
      flaky(api, step, 'a', 1)
      api.test('b', () => step('b'))
    }, DEFERRED)
    assert.deepEqual(run.trace, ['a#1', 'a#2', 'b'])
  })

  test('a test that declares its own retry keeps it; the default is for the others', async () => {
    const run = await runScript((api, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(1))
      flaky(api, step, 'own', 10, { retry: 2 })
      flaky(api, step, 'plain', 10)
    }, DEFERRED)
    assert.deepEqual(run.trace, ['own#1', 'plain#1', 'own#2', 'own#3', 'plain#2'])
  })

  test('is read when a suite starts running: a call in a beforeAll counts for that describe', async () => {
    const run = await runScript(({ describe, beforeAll, test }, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(1))
      describe('no retries', () => {
        beforeAll(() => runtime.setDefaultRetry(retryTimes(0)))
        let calls = 0
        test('a', () => {
          step(`a#${++calls}`)
          throw new Error('always')
        })
      })
      describe('more retries', () => {
        beforeAll(() => runtime.setDefaultRetry(retryTimes(2)))
        let calls = 0
        test('b', () => {
          step(`b#${++calls}`)
          throw new Error('always')
        })
      })
    }, DEFERRED)
    assert.deepEqual(run.trace, ['a#1', 'b#1', 'b#2', 'b#3'])
  })

  test('a call from a test body changes the describes that start after it, not the running one', async () => {
    const run = await runScript(({ describe, test }, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(0))
      describe('first', () => {
        test('sets it', () => {
          runtime.setDefaultRetry(retryTimes(1))
          step('sets it')
        })
        let calls = 0
        test('fails', () => {
          step(`first#${++calls}`)
          throw new Error('always')
        })
      })
      describe('second', () => {
        let calls = 0
        test('fails', () => {
          step(`second#${++calls}`)
          throw new Error('always')
        })
      })
    }, DEFERRED)
    assert.deepEqual(run.trace, ['sets it', 'first#1', 'second#1', 'second#2'])
  })

  test('`undefined` clears it', async () => {
    const run = await runScript((api, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(2))
      runtime.setDefaultRetry(undefined)
      flaky(api, step, 'a', 1)
    }, DEFERRED)
    assert.deepEqual(run.trace, ['a#1'])
  })

  test('does not outlive the file: the next file on the runtime starts with none', async () => {
    let setIt = true
    const run = await runScript((api, step, runtime) => {
      if (setIt) runtime.setDefaultRetry(retryTimes(2))
      flaky(api, step, 'a', 1)
    }, DEFERRED)
    assert.deepEqual(run.trace, ['a#1', 'a#2'])
    setIt = false
    await run.runtime.runFile('/project/second.test.ts')
    assert.deepEqual(run.trace.slice(2), ['a#1'])
  })

  test('a count below 1 or that is not a number is no retry', async () => {
    for (const count of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const run = await runScript((api, step, runtime) => {
        runtime.setDefaultRetry(retryTimes(count))
        flaky(api, step, 'a', 10)
      }, DEFERRED)
      assert.deepEqual(run.trace, ['a#1'], `count ${count}`)
    }
  })

  test('logErrors keeps the retried attempts errors on the result, as Jest logErrorsBeforeRetry does', async () => {
    const logged = await runScript(
      (api, step, runtime) => {
        runtime.setDefaultRetry(retryTimes(2, { logErrors: true }))
        flaky(api, step, 'a', 2)
      },
      { retry: { timing: 'deferred', keepEarlierErrors: false } },
    )
    assert.deepEqual(
      logged.results.a?.retryErrors.map((error) => error.message),
      ['a fail 1', 'a fail 2'],
    )
    const quiet = await runScript(
      (api, step, runtime) => {
        runtime.setDefaultRetry(retryTimes(2, { logErrors: false }))
        flaky(api, step, 'a', 2)
      },
      { retry: { timing: 'deferred', keepEarlierErrors: false } },
    )
    assert.deepEqual(quiet.results.a?.retryErrors, [])
  })
})

describe('retry delay', () => {
  test('waits the delay before each retry, on the runtimes timers', async () => {
    const clock = FakeTimers.createClock(0)
    const gate = Promise.withResolvers<void>()
    const running = runScript(
      (api, step, runtime) => {
        runtime.setDefaultRetry(retryTimes(2, { delay: 100 }))
        flaky(api, step, 'a', 2)
        api.test('b', () => {
          step('b')
          gate.resolve()
        })
      },
      DEFERRED,
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(gate.promise, running)
    // `a` failed once and waits for the end of the describe, then the delay.
    await clock.tickAsync(0)
    assert.equal(state.settled, false)
    await clock.tickAsync(99)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    await clock.tickAsync(99)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.deepEqual(run.trace, ['a#1', 'b', 'a#2', 'a#3'])
  })

  test('an immediate retry option { count, delay } waits after the failed attempt', async () => {
    const clock = FakeTimers.createClock(0)
    const gate = Promise.withResolvers<void>()
    const running = runScript(
      ({ test }, step) => {
        let calls = 0
        test('a', { retry: { count: 1, delay: 50 } }, () => {
          step(`a#${++calls}`)
          if (calls === 1) {
            gate.resolve()
            throw new Error('first fails')
          }
        })
      },
      {},
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(gate.promise, running)
    await clock.tickAsync(49)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.deepEqual(run.trace, ['a#1', 'a#2'])
    assert.equal(run.states.a, 'pass')
  })
})

describe('retry condition', () => {
  /** Fails `every` attempt with "<kind> failure". */
  const failing =
    (kind: string, condition: unknown): Script =>
    ({ test }, step) => {
      let calls = 0
      test('a', { retry: { count: 3, condition } as never }, () => {
        step(`a#${++calls}`)
        throw new Error(`${kind} failure`)
      })
    }

  test('a RegExp is tested against the last errors message: no match, no retry', async () => {
    const run = await runScript(failing('network', /network/), {})
    assert.deepEqual(run.trace, ['a#1', 'a#2', 'a#3', 'a#4'])
    const other = await runScript(failing('logic', /network/), {})
    assert.deepEqual(other.trace, ['a#1'])
    assert.equal(other.states.a, 'fail')
  })

  test('a function gets the error and decides; it is not asked after the last attempt', async () => {
    const asked: string[] = []
    const run = await runScript(
      failing('network', (error: { message: string }) => {
        asked.push(error.message)
        return true
      }),
      {},
    )
    assert.deepEqual(run.trace, ['a#1', 'a#2', 'a#3', 'a#4'])
    assert.deepEqual(asked, ['network failure', 'network failure', 'network failure'])
  })

  test('the file default has no condition: every failure retries', async () => {
    const run = await runScript((api, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(1))
      flaky(api, step, 'a', 1)
    }, DEFERRED)
    assert.deepEqual(run.trace, ['a#1', 'a#2'])
  })

  test('a condition applies to deferred retries too', async () => {
    const run = await runScript(({ test }, step) => {
      test('a', { retry: { count: 2, condition: /retry me/ } }, () => {
        step('a')
        throw new Error('do not')
      })
      test('b', () => step('b'))
    }, DEFERRED)
    assert.deepEqual(run.trace, ['a', 'b'])
  })

  test('a condition that throws ends the retries and fails the test with what it threw', async () => {
    const run = await runScript(
      failing('network', () => {
        throw new Error('condition broke')
      }),
      {},
    )
    assert.deepEqual(run.trace, ['a#1'])
    assert.equal(run.states.a, 'fail')
    assert.ok(run.errors.a?.includes('condition broke'))
  })
})

// Jest's `handleRetry` (jest-circus run.ts) returns for a test that had errors before it ran,
// deferred or `retryImmediately` alike; recorded as `runtime/retry-before-all-error`. An attached
// `beforeAll` error meets every attempt again, so no policy retries it.
describe('a test with errors before it ran (an attached beforeAll error)', () => {
  /** A `beforeAll` that throws, then a test with `retry`, tracing the hook and the body. */
  const afterFailedBeforeAll =
    (options: { retry?: RetryOption }): Script =>
    ({ describe, test, beforeAll }, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(2))
      describe('d', () => {
        beforeAll(() => {
          step('beforeAll')
          throw new Error('beforeAll failed')
        })
        test('t', options, () => step('body'))
      })
    }

  for (const [label, overrides] of [
    ['deferred', DEFERRED],
    ['immediate', { retry: { timing: 'immediate' } }],
  ] as const) {
    test(`is not retried under ${label} timing: one attempt, no willRetry, the beforeAll error is its failure`, async () => {
      const run = await runScript(afterFailedBeforeAll({}), overrides)
      assert.deepEqual(run.trace, ['beforeAll'])
      assert.equal(run.results['d > t']?.attempts, 1)
      assert.equal(run.states['d > t'], 'fail')
      assert.deepEqual(run.errors['d > t'], ['beforeAll failed'])
      assert.ok(!eventLog(run).some((line) => line.includes('will-retry')))
    })

    test(`is not retried under ${label} timing with a retry option of its own`, async () => {
      const run = await runScript(afterFailedBeforeAll({ retry: 3 }), overrides)
      assert.deepEqual(run.trace, ['beforeAll'])
      assert.equal(run.results['d > t']?.attempts, 1)
    })
  }

  test('its retry condition is never asked', async () => {
    const asked: string[] = []
    const run = await runScript(
      afterFailedBeforeAll({
        retry: {
          count: 2,
          condition: (error) => {
            asked.push(error.message)
            return true
          },
        },
      }),
      DEFERRED,
    )
    assert.equal(run.results['d > t']?.attempts, 1)
    assert.deepEqual(asked, [])
  })

  test('a sibling describe whose beforeAll passed still retries its failing test', async () => {
    const run = await runScript(({ describe, test, beforeAll }, step, runtime) => {
      runtime.setDefaultRetry(retryTimes(2))
      describe('broken', () => {
        beforeAll(() => {
          throw new Error('beforeAll failed')
        })
        test('t', () => step('broken body'))
      })
      describe('fine', () => {
        let calls = 0
        test('t', () => {
          step(`fine#${++calls}`)
          if (calls === 1) throw new Error('first attempt fails')
        })
      })
    }, DEFERRED)
    assert.deepEqual(run.trace, ['fine#1', 'fine#2'])
    assert.equal(run.results['broken > t']?.attempts, 1)
    assert.equal(run.results['fine > t']?.attempts, 2)
  })
})
