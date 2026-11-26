// T5.6 acceptance, part 2: timeouts. Every deadline runs on a fake clock injected as `realTimers`
// and `now`, so nothing waits on wall time. A test starts the run, waits for the code under test to
// say it has started (an explicit promise), then advances the clock.
import assert from 'node:assert/strict'
import {
  type BehaviourLoader,
  createBehaviourLoader,
  isModuleRef,
  moduleRef,
} from '@provino/policy'
import type { AnyFunction, Behaviour, FormatTimeout } from '@provino/types'
import FakeTimers, { type Clock } from '@sinonjs/fake-timers'
import { beforeEach, describe, test } from 'provino'
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

  test('bounds a LazyHost teardown of a test: one that never settles fails the test with CORE_TIMEOUT', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test }, _step, runtime) => {
        test('t', (ctx) => {
          runtime.lazyHost.runOf(ctx)?.addTeardown(() => {
            signal()
            return hang()
          })
        })
        test('next', () => {})
      },
      { timeouts: { teardown: 70 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(69)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.equal(codeOf(run, 't'), 'CORE_TIMEOUT')
    assert.equal(run.states.next, 'pass')
  })

  test('bounds a file teardown: one that never settles fails the file with CORE_TIMEOUT', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test }, _step, runtime) => {
        runtime.lazyHost.collecting()?.file.teardowns.push(() => {
          signal()
          return hang()
        })
        test('t', () => {})
      },
      { timeouts: { teardown: 70 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started, running)
    await clock.tickAsync(69)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.deepEqual(
      run.file.errors.map((error) => error.code),
      ['CORE_TIMEOUT'],
    )
    assert.equal(run.states.t, 'pass')
  })

  test('bounds a worker teardown: dispose runs the rest, then rejects with CORE_TIMEOUT among its errors', async () => {
    const { started, signal } = startSignal()
    const run = await runScript(
      ({ test }, step, runtime) => {
        runtime.lazyHost.addWorkerTeardown(() => step('first added'))
        runtime.lazyHost.addWorkerTeardown(() => {
          signal()
          return hang()
        })
        test('t', () => {})
      },
      { timeouts: { teardown: 70 } },
      clockOptions(clock),
    )
    const disposing = run.runtime.dispose()
    disposing.catch(() => {})
    await reached(started, disposing)
    await clock.tickAsync(70)
    await assert.rejects(disposing, (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(
        error.errors.map((inner: { code?: string }) => inner.code),
        ['CORE_TIMEOUT'],
      )
      return true
    })
    assert.deepEqual(run.trace, ['first added'])
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

describe('timeouts.message', () => {
  /** A formatter that says what it was asked: `<subject>[ done] <ms>`. */
  const REF = moduleRef<FormatTimeout>('test:format-timeout', 'formatTimeout')
  const format: FormatTimeout = ({ subject, ms, done }) => `${subject}${done ? ' done' : ''} ${ms}`
  const behaviours: BehaviourLoader = {
    async load<Fn extends AnyFunction>(behaviour: Behaviour<Fn>): Promise<Fn> {
      if (isModuleRef(behaviour) && behaviour.module === REF.module) return format as unknown as Fn
      return createBehaviourLoader().load(behaviour)
    },
  }
  const withFormat = (extra: Record<string, unknown> = {}) => ({
    ...clockOptions(clock),
    behaviours,
    ...extra,
  })
  const hangs =
    (signal: () => void): Script =>
    ({ test }) => {
      test('slow', () => {
        signal()
        return hang()
      })
    }
  /** `Error: <text>` and the frame of the call that registered the test or hook. */
  const stackOf = (text: string): RegExp =>
    new RegExp(`^Error: ${text}\\n {4}at \\S*timeouts\\.test\\.ts:\\d+:\\d+$`)

  test('a test that times out fails with the runner’s text, as a plain Error at the place the test was registered', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      hangs(signal),
      { timeouts: { test: 300, message: REF } },
      withFormat({ locations: true }),
    )
    await reached(started, running)
    await clock.tickAsync(300)
    const [error, ...others] = (await running).results.slow?.errors ?? []
    assert.equal(others.length, 0)
    assert.equal(error?.code, 'CORE_TIMEOUT')
    assert.equal(error?.name, 'Error')
    assert.equal(error?.message, 'test 300')
    assert.match(error?.stack ?? '', stackOf('test 300'))
  })

  test('a timeout given to the test is the one the text names', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test }) => {
        test('slow', () => {
          signal()
          return hang()
        }, 50)
      },
      { timeouts: { test: 5000, message: REF } },
      withFormat(),
    )
    await reached(started, running)
    await clock.tickAsync(50)
    assert.deepEqual((await running).errors.slow, ['test 50'])
  })

  test('a hook that times out fails with the hook text, at the place the hook was registered', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test, beforeEach }) => {
        beforeEach(() => {
          signal()
          return hang()
        })
        test('t', () => {})
      },
      { timeouts: { hook: 400, message: REF } },
      withFormat({ locations: true }),
    )
    await reached(started, running)
    await clock.tickAsync(400)
    const [error] = (await running).results.t?.errors ?? []
    assert.equal(error?.code, 'CORE_TIMEOUT')
    assert.equal(error?.message, 'hook 400')
    assert.match(error?.stack ?? '', stackOf('hook 400'))
  })

  test('a function that takes a done callback has the done texts', async () => {
    const { started, signal } = startSignal()
    const never = ((_done: () => void) => signal()) as never
    const running = runScript(
      ({ test, beforeEach }) => {
        beforeEach(never)
        test('t', never)
      },
      { firstArg: 'done-if-arity', timeouts: { test: 200, hook: 100, message: REF } },
      withFormat(),
    )
    await reached(started, running)
    await clock.tickAsync(100)
    assert.deepEqual((await running).errors.t, ['hook done 100'])
    const test = startSignal()
    const body = runScript(
      ({ test: define }) => {
        define('t', ((_done: () => void) => test.signal()) as never)
      },
      { firstArg: 'done-if-arity', timeouts: { test: 200, message: REF } },
      withFormat(),
    )
    await reached(test.started, body)
    await clock.tickAsync(200)
    assert.deepEqual((await body).errors.t, ['test done 200'])
  })

  test('a teardown keeps core’s words: the runner has none', async () => {
    const { started, signal } = startSignal()
    const running = runScript(
      ({ test }, _step, runtime) => {
        test('t', (ctx) => {
          runtime.lazyHost.runOf(ctx)?.addTeardown(() => {
            signal()
            return hang()
          })
        })
      },
      { timeouts: { teardown: 50, message: REF } },
      withFormat(),
    )
    await reached(started, running)
    await clock.tickAsync(50)
    const [error] = (await running).results.t?.errors ?? []
    assert.equal(error?.code, 'CORE_TIMEOUT')
    assert.match(error?.message ?? '', /Teardown timed out in 50ms/)
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

  for (const [what, timeoutMs] of [
    ['0', 0],
    ['above 2^31 - 1 ms', 2 ** 31],
  ] as const) {
    test(`true with a test timeout of ${what} sets no deadline for the hooks or the body`, async () => {
      const hook = startSignal()
      const body = startSignal()
      const hookGate = Promise.withResolvers<void>()
      const bodyGate = Promise.withResolvers<void>()
      const running = runScript(
        ({ test, beforeEach }) => {
          beforeEach(() => {
            hook.signal()
            return hookGate.promise
          })
          test(
            't',
            () => {
              body.signal()
              return bodyGate.promise
            },
            timeoutMs,
          )
        },
        { hooks: { timeoutCountsTestTimeout: true } },
        clockOptions(clock),
      )
      await reached(hook.started, running)
      await clock.tickAsync(1_000_000)
      hookGate.resolve()
      await reached(body.started, running)
      await clock.tickAsync(1_000_000)
      bodyGate.resolve()
      const run = await running
      assert.equal(run.states.t, 'pass', run.errors.t?.join('\n'))
    })
  }

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

describe('setDefaultTimeout (jest.setTimeout)', () => {
  test('replaces the policy default for a test declared before the call, not an explicit timeout', async () => {
    const first = startSignal()
    const second = startSignal()
    const running = runScript(
      ({ test }, _step, runtime) => {
        test('before', () => {
          first.signal()
          return hang()
        })
        runtime.setDefaultTimeout(300)
        test('explicit', () => {
          second.signal()
          return hang()
        }, 100)
      },
      {},
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(first.started, running)
    // `before` has the policy's 5000 ms, but the call raised the default to 300: read when it runs.
    await clock.tickAsync(299)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    await reached(second.started, running)
    await clock.tickAsync(99)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.equal(codeOf(run, 'before'), 'CORE_TIMEOUT')
    assert.equal(codeOf(run, 'explicit'), 'CORE_TIMEOUT')
  })

  test('`undefined` is no timeout given, and a call after the run started changes nothing', async () => {
    const hold = startSignal()
    const running = runScript(
      ({ test }, _step, runtime) => {
        runtime.setDefaultTimeout(undefined)
        test('slow', () => {
          // circus copies the default at run_start: a call from a test body is ignored.
          runtime.setDefaultTimeout(60_000)
          hold.signal()
          return hang()
        })
      },
      { timeouts: { test: 300 } },
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(hold.started, running)
    await clock.tickAsync(299)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    assert.equal(codeOf(await running, 'slow'), 'CORE_TIMEOUT')
  })
})

describe('the clock the deadlines read', () => {
  /**
   * Runs a test that fakes `performance` the way `timers.useFakeTimers()` does, moves the system
   * time to `date` and clears the fake timers, with an `afterEach` that puts the real clock back
   * (`timers.useRealTimers()`). `reset` keeps the offset `setSystemTime` made, so the fake
   * `performance.now()` then reads years behind the real one (a date ahead) or ahead of it (a date
   * behind). No `now` is injected: this is the runtime's own clock.
   */
  async function runWithMovedClock(date: Date): Promise<ScriptRun> {
    let fake: ReturnType<typeof FakeTimers.install> | undefined
    const restore = (): void => {
      fake?.uninstall()
      fake = undefined
    }
    try {
      return await runScript(({ test, afterEach }) => {
        afterEach(restore)
        test('moves the fake clock', () => {
          fake = FakeTimers.install({ toFake: ['performance'], now: Date.now() })
          fake.setSystemTime(date)
          fake.reset()
        })
      })
    } finally {
      restore()
    }
  }

  test('a test that moved the fake clock ahead and cleared its timers does not time out its afterEach', async () => {
    const run = await runWithMovedClock(new Date('2030-01-01'))
    assert.deepEqual(run.errors['moves the fake clock'], [])
    assert.equal(run.states['moves the fake clock'], 'pass')
  })

  test('a test that moved the fake clock back and cleared its timers does not time out', async () => {
    const run = await runWithMovedClock(new Date('2000-01-01'))
    assert.deepEqual(run.errors['moves the fake clock'], [])
    assert.equal(run.states['moves the fake clock'], 'pass')
  })

  test('an async test still has all of its timeout (a policy that checks no synchronous overrun, Jest’s)', async () => {
    const { started, signal } = startSignal()
    const release = Promise.withResolvers<void>()
    let fake: ReturnType<typeof FakeTimers.install> | undefined
    const restore = (): void => {
      fake?.uninstall()
      fake = undefined
    }
    try {
      const running = runScript(
        ({ test, afterEach }) => {
          afterEach(restore)
          test('waits', async () => {
            fake = FakeTimers.install({ toFake: ['performance'], now: Date.now() })
            fake.setSystemTime(new Date('2000-01-01'))
            fake.reset()
            signal()
            await release.promise
          })
        },
        { timeouts: { test: 5000, catchSyncOverrun: false } },
        { realTimers: timersOf(clock) },
      )
      await reached(started, running)
      // The deadline was armed for what is left of 5000 ms: none of it is gone after 100 ms.
      await clock.tickAsync(100)
      release.resolve()
      const run = await running
      assert.deepEqual(run.errors.waits, [])
      assert.equal(run.states.waits, 'pass')
    } finally {
      restore()
    }
  })
})
