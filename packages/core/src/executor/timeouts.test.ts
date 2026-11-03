// T5.6 acceptance, part 2: timeouts. Every deadline runs on a fake clock injected as `realTimers`
// and `now`, so nothing waits on wall time. A test starts the run, waits for the code under test to
// say it has started (an explicit promise), then advances the clock.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import FakeTimers, { type Clock } from '@sinonjs/fake-timers'
import {
  clockOptions,
  eventLog,
  reached,
  runScript,
  type Script,
  type ScriptRun,
  timersOf,
  watch,
} from '../internal/test-support.ts'

let clock: Clock

beforeEach(() => {
  clock = FakeTimers.createClock(0)
})

/** Never settles. */
const hang = (): Promise<never> => new Promise(() => {})

/** What a script calls to say the code under test has begun. */
function startSignal(): { started: Promise<void>; signal: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { started: promise, signal: resolve }
}

/** The code of the first error of a test. */
const codeOf = (run: ScriptRun, name: string): string | undefined =>
  run.results[name]?.errors[0]?.code

describe('timeouts.test', () => {
  const hangs =
    (signal: () => void): Script =>
    ({ test }) => {
      test('slow', () => {
        signal()
        return hang()
      })
    }

  test('the default is 5000 ms: a test still running then fails with CORE_TIMEOUT, not before', async () => {
    const { started, signal } = startSignal()
    const running = runScript(hangs(signal), {}, clockOptions(clock))
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(4999)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.equal(run.states.slow, 'fail')
    assert.equal(codeOf(run, 'slow'), 'CORE_TIMEOUT')
  })

  test('a value set in the policy replaces the default', async () => {
    const { started, signal } = startSignal()
    const running = runScript(hangs(signal), { timeouts: { test: 300 } }, clockOptions(clock))
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(299)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    assert.equal(codeOf(await running, 'slow'), 'CORE_TIMEOUT')
  })

  test('a timeout given to the test replaces the policy value', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test }) => {
        test('slow', () => {
          signal()
          return hang()
        }, 50)
      },
      { timeouts: { test: 5000 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(49)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    assert.equal(codeOf(await running, 'slow'), 'CORE_TIMEOUT')
  })

  test('the error names the timeout', async () => {
    const { started, signal } = startSignal()
    const running = runScript(hangs(signal), { timeouts: { test: 300 } }, clockOptions(clock))
    await reached(started, running)
    await clock.tickAsync(300)
    assert.match((await running).errors.slow?.[0] ?? '', /300/)
  })

  test('a test that finishes in time leaves no timer behind', async () => {
    const run = await runScript(
      ({ test }) => {
        test('quick', async () => {})
      },
      {},
      clockOptions(clock),
    )
    assert.equal(run.states.quick, 'pass')
    assert.equal(clock.countTimers(), 0)
  })

  test('the next test runs after one has timed out', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test }, step) => {
        test('slow', () => {
          signal()
          return hang()
        })
        test('next', () => step('next ran'))
      },
      { timeouts: { test: 100 } },
      clockOptions(clock),
    )
    await reached(started, running)
    await clock.tickAsync(100)
    const run = await running
    assert.deepEqual(run.states, { slow: 'fail', next: 'pass' })
  })

  test('a test that takes a done callback and never calls it times out', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test }) => {
        test('never done', ((_done: () => void) => {
          signal()
        }) as never)
      },
      { firstArg: 'done-if-arity', timeouts: { test: 200 } },
      clockOptions(clock),
    )
    await reached(started, running)
    await clock.tickAsync(200)
    assert.equal(codeOf(await running, 'never done'), 'CORE_TIMEOUT')
  })
})

describe('ctx.signal', () => {
  test('is aborted with the timeout error when the test times out', async () => {
    const { started, signal } = startSignal()
    let seen: AbortSignal | undefined
    const running = runScript(
      ({ test }) => {
        test('slow', (ctx) => {
          seen = ctx.signal
          signal()
          return hang()
        })
      },
      { timeouts: { test: 100 } },
      clockOptions(clock),
    )
    await reached(started, running)
    assert.equal(seen?.aborted, false)
    await clock.tickAsync(100)
    await running
    assert.equal(seen?.aborted, true)
    assert.equal((seen?.reason as { code?: string } | undefined)?.code, 'CORE_TIMEOUT')
  })

  test('is not aborted for a test that passes', async () => {
    let seen: AbortSignal | undefined
    await runScript(
      ({ test }) => {
        test('quick', (ctx) => {
          seen = ctx.signal
        })
      },
      {},
      clockOptions(clock),
    )
    assert.equal(seen?.aborted, false)
  })

  test('is aborted when a hook of the test times out', async () => {
    const { started, signal } = startSignal()
    let seen: AbortSignal | undefined
    const running = runScript(
      ({ test, beforeEach }) => {
        beforeEach((ctx) => {
          seen = ctx.signal
          signal()
          return hang()
        })
        test('t', () => {})
      },
      { timeouts: { hook: 100 } },
      clockOptions(clock),
    )
    await reached(started, running)
    await clock.tickAsync(100)
    await running
    assert.equal(seen?.aborted, true)
    assert.equal((seen?.reason as { code?: string } | undefined)?.code, 'CORE_TIMEOUT')
  })
})

describe('timeouts.hook', () => {
  test('a beforeEach that outlasts it fails the test with CORE_TIMEOUT, and the body never runs', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test, beforeEach }, step) => {
        beforeEach(() => {
          signal()
          return hang()
        })
        test('t', () => step('body'))
      },
      { timeouts: { hook: 400 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(399)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.equal(codeOf(run, 't'), 'CORE_TIMEOUT')
    assert.deepEqual(run.trace, [])
  })

  test('a timeout given to the hook replaces the policy value', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test, beforeEach }) => {
        beforeEach(() => {
          signal()
          return hang()
        }, 60)
        test('t', () => {})
      },
      { timeouts: { hook: 10_000 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(59)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    assert.equal(codeOf(await running, 't'), 'CORE_TIMEOUT')
  })

  test('an afterEach that outlasts it fails a test whose body passed', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test, afterEach }, step) => {
        afterEach(() => {
          signal()
          return hang()
        })
        test('t', () => step('body'))
      },
      { timeouts: { hook: 100 } },
      clockOptions(clock),
    )
    await reached(started, running)
    await clock.tickAsync(100)
    const run = await running
    assert.deepEqual(run.trace, ['body'])
    assert.equal(codeOf(run, 't'), 'CORE_TIMEOUT')
  })

  test('a beforeAll that outlasts it fails the tests below it', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ describe, test, beforeAll }) => {
        describe('a', () => {
          beforeAll(() => {
            signal()
            return hang()
          })
          test('t', () => {})
        })
      },
      { timeouts: { hook: 100 } },
      clockOptions(clock),
    )
    await reached(started, running)
    await clock.tickAsync(100)
    assert.equal(codeOf(await running, 'a > t'), 'CORE_TIMEOUT')
  })

  test('an afterAll that outlasts it fails its suite', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ describe, test, afterAll }) => {
        describe('a', () => {
          afterAll(() => {
            signal()
            return hang()
          })
          test('t', () => {})
        })
      },
      { timeouts: { hook: 100 } },
      clockOptions(clock),
    )
    await reached(started, running)
    await clock.tickAsync(100)
    const run = await running
    assert.equal(run.states['a > t'], 'pass')
    assert.equal(run.suites.a?.errors[0]?.code, 'CORE_TIMEOUT')
  })

  test('an onTestFinished callback uses it too, unless it is given its own', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test }) => {
        test('t', (ctx) => {
          ctx.onTestFinished(() => {
            signal()
            return hang()
          }, 30)
        })
      },
      { timeouts: { hook: 10_000 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(29)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    assert.equal(codeOf(await running, 't'), 'CORE_TIMEOUT')
  })
})

describe('timeouts.teardown', () => {
  const script =
    (signal: () => void): Script =>
    ({ test, beforeEach }) => {
      beforeEach(() => () => {
        signal()
        return hang()
      })
      test('t', () => {})
    }

  test('a returned cleanup that outlasts it fails the test with CORE_TIMEOUT', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      script(signal),
      { timeouts: { teardown: 70, hook: 10_000 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(69)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.equal(codeOf(run, 't'), 'CORE_TIMEOUT')
    assert.ok(eventLog(run).includes('hook-end teardown#0 owner=file test=t failed'))
  })

  test('is not the hook timeout: a cleanup is not cut off by a short hook timeout', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      script(signal),
      { timeouts: { teardown: 10_000, hook: 70 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(5000)
    assert.equal(state.settled, false)
    await clock.tickAsync(5000)
    assert.equal(codeOf(await running, 't'), 'CORE_TIMEOUT')
  })
})

describe('timeouts.catchSyncOverrun', () => {
  /** A fake `now` the script moves by hand, so a synchronous body can "take" time. */
  function spend(): { now: () => number; spend: (ms: number) => void } {
    let elapsed = 0
    return {
      now: () => elapsed,
      spend: (ms) => {
        elapsed += ms
      },
    }
  }

  test('true fails a test whose synchronous body ran past the timeout', async () => {
    const time = spend()
    const run = await runScript(
      ({ test }) => {
        test('busy', () => time.spend(6000))
      },
      { timeouts: { test: 5000, catchSyncOverrun: true } },
      { realTimers: timersOf(clock), now: time.now },
    )
    assert.equal(run.states.busy, 'fail')
    assert.equal(codeOf(run, 'busy'), 'CORE_TIMEOUT')
  })

  test('false lets the same test pass', async () => {
    const time = spend()
    const run = await runScript(
      ({ test }) => {
        test('busy', () => time.spend(6000))
      },
      { timeouts: { test: 5000, catchSyncOverrun: false } },
      { realTimers: timersOf(clock), now: time.now },
    )
    assert.equal(run.states.busy, 'pass')
  })

  test('true lets a synchronous body that stayed inside the timeout pass', async () => {
    const time = spend()
    const run = await runScript(
      ({ test }) => {
        test('brisk', () => time.spend(4999))
      },
      { timeouts: { test: 5000, catchSyncOverrun: true } },
      { realTimers: timersOf(clock), now: time.now },
    )
    assert.equal(run.states.brisk, 'pass')
  })

  test('true applies to hooks as well', async () => {
    const time = spend()
    const run = await runScript(
      ({ test, beforeEach }) => {
        beforeEach(() => time.spend(300))
        test('t', () => {})
      },
      { timeouts: { hook: 200, catchSyncOverrun: true } },
      { realTimers: timersOf(clock), now: time.now },
    )
    assert.equal(codeOf(run, 't'), 'CORE_TIMEOUT')
  })

  test('false lets a hook that ran past the timeout pass', async () => {
    const time = spend()
    const run = await runScript(
      ({ test, beforeEach }) => {
        beforeEach(() => time.spend(300))
        test('t', () => {})
      },
      { timeouts: { hook: 200, catchSyncOverrun: false } },
      { realTimers: timersOf(clock), now: time.now },
    )
    assert.equal(run.states.t, 'pass')
  })
})

describe('hooks.timeoutCountsTestTimeout', () => {
  /** A test with a 1000 ms timeout whose beforeEach takes 600 ms, then a body that hangs. */
  const slowHookThenHang =
    (signal: () => void): Script =>
    ({ test, beforeEach }) => {
      beforeEach(() => {
        clock.tick(600)
      })
      test('slow', () => {
        signal()
        return hang()
      }, 1000)
    }

  test('true gives the body only what the hooks left of the test timeout', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      slowHookThenHang(signal),
      { hooks: { timeoutCountsTestTimeout: true } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(399)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.equal(codeOf(run, 'slow'), 'CORE_TIMEOUT')
  })

  test('false gives the body the whole test timeout, however long the hooks took', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      slowHookThenHang(signal),
      { hooks: { timeoutCountsTestTimeout: false } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(400)
    assert.equal(state.settled, false)
    await clock.tickAsync(599)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    assert.equal(codeOf(await running, 'slow'), 'CORE_TIMEOUT')
  })

  const hangingHook =
    (signal: () => void): Script =>
    ({ test, beforeEach }) => {
      beforeEach(() => {
        signal()
        return hang()
      })
      test('t', () => {}, 1000)
    }

  test('true makes a hanging beforeEach time out with the test, not with the hook timeout', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      hangingHook(signal),
      { timeouts: { hook: 3000 }, hooks: { timeoutCountsTestTimeout: true } },
      clockOptions(clock),
    )
    await reached(started, running)
    await clock.tickAsync(1000)
    assert.equal(codeOf(await running, 't'), 'CORE_TIMEOUT')
  })

  test('false leaves a hanging beforeEach to the hook timeout', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      hangingHook(signal),
      { timeouts: { hook: 3000 }, hooks: { timeoutCountsTestTimeout: false } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(1000)
    assert.equal(state.settled, false)
    await clock.tickAsync(2000)
    assert.equal(codeOf(await running, 't'), 'CORE_TIMEOUT')
  })
})
