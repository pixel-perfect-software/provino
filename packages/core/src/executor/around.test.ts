// `aroundEach` and `aroundAll`: nesting order, the three error classes, the separate setup and
// teardown timeouts (on a fake clock), and the `LazyHost` teardowns an `aroundEach` adds.
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
  settle,
  timersOf,
  trackRefs,
  watch,
} from '../internal/test-support.ts'

let clock: Clock

beforeEach(() => {
  clock = FakeTimers.createClock(0)
})

/** The names of the errors of a test. */
const errorNames = (run: ScriptRun, name: string): Array<string | undefined> =>
  run.results[name]?.errors.map((error) => error.name) ?? []

const hang = (): Promise<never> => new Promise(() => {})

describe('aroundEach order', () => {
  test('the first registered wraps the later ones, and every level wraps every beforeEach', async () => {
    const run = await runScript(({ describe, test, aroundEach, beforeEach, afterEach }, step) => {
      aroundEach(async (runTest) => {
        step('around r setup')
        await runTest()
        step('around r teardown')
      })
      beforeEach(() => step('beforeEach r'))
      afterEach(() => step('afterEach r'))
      describe('a', () => {
        aroundEach(async (runTest) => {
          step('around a setup')
          await runTest()
          step('around a teardown')
        })
        beforeEach(() => step('beforeEach a'))
        afterEach(() => step('afterEach a'))
        test('t', () => step('body'))
      })
    })
    assert.deepEqual(run.trace, [
      'around r setup',
      'around a setup',
      'beforeEach r',
      'beforeEach a',
      'body',
      'afterEach a',
      'afterEach r',
      'around a teardown',
      'around r teardown',
    ])
  })

  test('two hooks at one level nest in the order they were registered', async () => {
    const run = await runScript(({ test, aroundEach }, step) => {
      for (const name of ['first', 'second']) {
        aroundEach(async (runTest) => {
          step(`${name} setup`)
          await runTest()
          step(`${name} teardown`)
        })
      }
      test('t', () => step('body'))
    })
    assert.deepEqual(run.trace, [
      'first setup',
      'second setup',
      'body',
      'second teardown',
      'first teardown',
    ])
  })

  test('the hook receives the test context after the inner function', async () => {
    let seen: string | undefined
    await runScript(({ test, aroundEach }) => {
      aroundEach(async (runTest, ctx) => {
        seen = ctx.task.name
        await runTest()
      })
      test('t', () => {})
    })
    assert.equal(seen, 't')
  })

  test('the hook receives the innermost suite of the test third, as Vitest passes it', async () => {
    let seen: string | undefined
    await runScript(({ describe, test, aroundEach }) => {
      aroundEach(async (runTest, _ctx, suite) => {
        seen = suite.name
        await runTest()
      })
      describe('outer', () => {
        describe('inner', () => {
          test('t', () => {})
        })
      })
    })
    assert.equal(seen, 'inner')
  })

  test('runs again for each attempt of a retried test', async () => {
    const run = await runScript(({ test, aroundEach }, step) => {
      let calls = 0
      aroundEach(async (runTest) => {
        step('setup')
        await runTest()
      })
      test('t', { retry: 1 }, () => {
        if (++calls === 1) throw new Error('first attempt fails')
      })
    })
    assert.deepEqual(run.trace, ['setup', 'setup'])
  })

  test('is reported as a hook of its kind, owned by the suite it was declared on', async () => {
    const run = await runScript(({ test, aroundEach }) => {
      aroundEach(async (runTest) => {
        await runTest()
      })
      test('t', () => {})
    })
    const lines = eventLog(run)
    assert.ok(lines.includes('hook-start aroundEach#0 owner=file test=t'), lines.join('\n'))
    assert.ok(lines.includes('hook-end aroundEach#0 owner=file test=t'))
  })
})

describe('aroundAll order', () => {
  test('wraps the suite beforeAll hooks, its tests and its afterAll hooks', async () => {
    const run = await runScript(({ describe, test, aroundAll, beforeAll, afterAll }, step) => {
      describe('a', () => {
        aroundAll(async (runSuite) => {
          step('around setup')
          await runSuite()
          step('around teardown')
        })
        beforeAll(() => step('beforeAll'))
        afterAll(() => step('afterAll'))
        test('t', () => step('body'))
      })
    })
    assert.deepEqual(run.trace, [
      'around setup',
      'beforeAll',
      'body',
      'afterAll',
      'around teardown',
    ])
  })

  test('the hook receives the suite after the inner function', async () => {
    let seen: string | undefined
    await runScript(({ describe, test, aroundAll }) => {
      describe('a', () => {
        aroundAll(async (runSuite, suite) => {
          seen = suite.name
          await runSuite()
        })
        test('t', () => {})
      })
    })
    assert.equal(seen, 'a')
  })

  test('runs once for the suite, not once per test', async () => {
    const run = await runScript(({ describe, test, aroundAll }, step) => {
      describe('a', () => {
        aroundAll(async (runSuite) => {
          step('setup')
          await runSuite()
        })
        test('one', () => {})
        test('two', () => {})
      })
    })
    assert.deepEqual(run.trace, ['setup'])
  })
})

describe('around hook errors', () => {
  test('an aroundEach that never calls runTest fails the test with AroundHookSetupError', async () => {
    const run = await runScript(({ test, aroundEach }, step) => {
      aroundEach(() => {})
      test('t', () => step('body'))
    })
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(errorNames(run, 't'), ['AroundHookSetupError'])
    assert.deepEqual(run.trace, [])
  })

  test('an aroundAll that never calls runSuite fails the suite and skips its tests', async () => {
    const run = await runScript(({ describe, test, aroundAll }, step) => {
      describe('a', () => {
        aroundAll(() => {})
        test('t', () => step('body'))
      })
    })
    assert.equal(run.suites.a?.state, 'fail')
    assert.equal(run.suites.a?.errors[0]?.name, 'AroundHookSetupError')
    assert.equal(run.states['a > t'], 'skip')
    assert.deepEqual(run.trace, [])
  })

  test('calling runTest twice fails the test with AroundHookMultipleCallsError, the body having run once', async () => {
    const run = await runScript(({ test, aroundEach }, step) => {
      aroundEach(async (runTest) => {
        await runTest()
        await runTest()
      })
      test('t', () => step('body'))
    })
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(errorNames(run, 't'), ['AroundHookMultipleCallsError'])
    assert.deepEqual(run.trace, ['body'])
  })

  test('calling runSuite twice fails the suite with AroundHookMultipleCallsError', async () => {
    const run = await runScript(({ describe, test, aroundAll }, step) => {
      describe('a', () => {
        aroundAll(async (runSuite) => {
          await runSuite()
          await runSuite()
        })
        test('t', () => step('body'))
      })
    })
    assert.equal(run.suites.a?.errors[0]?.name, 'AroundHookMultipleCallsError')
    assert.deepEqual(run.trace, ['body'])
  })

  test('a hook that throws before calling runTest fails the test, and the body never runs', async () => {
    const run = await runScript(({ test, aroundEach }, step) => {
      aroundEach(async () => {
        throw new Error('setup failed')
      })
      test('t', () => step('body'))
    })
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.trace, [])
    assert.equal(run.results.t?.errors.length, 1)
  })

  test('a hook that throws is reported with its error on its hook-end event', async () => {
    const run = await runScript(({ test, aroundEach }) => {
      aroundEach(async () => {
        throw new Error('setup failed')
      })
      test('t', () => {})
    })
    assert.ok(eventLog(run).includes('hook-end aroundEach#0 owner=file test=t failed'))
  })
})

describe('around hook timeouts', () => {
  test('a setup that outlasts the hook timeout fails the test with AroundHookSetupError', async () => {
    const started = Promise.withResolvers<void>()
    const running = runScript(
      ({ test, aroundEach }, step) => {
        aroundEach(async () => {
          started.resolve()
          await hang()
        }, 100)
        test('t', () => step('body'))
      },
      {},
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started.promise, running)
    await clock.tickAsync(99)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.deepEqual(errorNames(run, 't'), ['AroundHookSetupError'])
    assert.deepEqual(run.trace, [])
  })

  test('the policy hook timeout applies when the hook has none of its own', async () => {
    const started = Promise.withResolvers<void>()
    const running = runScript(
      ({ test, aroundEach }) => {
        aroundEach(async () => {
          started.resolve()
          await hang()
        })
        test('t', () => {})
      },
      { timeouts: { hook: 250 } },
      clockOptions(clock),
    )
    await reached(started.promise, running)
    await clock.tickAsync(250)
    assert.deepEqual(errorNames(await running, 't'), ['AroundHookSetupError'])
  })

  test('a setup timeout aborts the test signal', async () => {
    const started = Promise.withResolvers<void>()
    let signal: AbortSignal | undefined
    const running = runScript(
      ({ test, aroundEach }) => {
        aroundEach(async (_runTest, ctx) => {
          signal = ctx.signal
          started.resolve()
          await hang()
        }, 100)
        test('t', () => {})
      },
      {},
      clockOptions(clock),
    )
    await reached(started.promise, running)
    await clock.tickAsync(100)
    await running
    assert.equal(signal?.aborted, true)
  })

  test('a teardown that outlasts the hook timeout fails the test with AroundHookTeardownError, after the body passed', async () => {
    const started = Promise.withResolvers<void>()
    const running = runScript(
      ({ test, aroundEach }, step) => {
        aroundEach(async (runTest) => {
          await runTest()
          started.resolve()
          await hang()
        }, 100)
        test('t', () => step('body'))
      },
      {},
      clockOptions(clock),
    )
    const state = watch(running)
    await reached(started.promise, running)
    await clock.tickAsync(99)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    const run = await running
    assert.deepEqual(run.trace, ['body'])
    assert.deepEqual(errorNames(run, 't'), ['AroundHookTeardownError'])
  })

  test('setup and teardown each get the whole timeout', async () => {
    const run = await runScript(
      ({ test, aroundEach }) => {
        aroundEach(async (runTest) => {
          await clock.tickAsync(60)
          await runTest()
          await clock.tickAsync(60)
        }, 100)
        test('t', () => {})
      },
      {},
      clockOptions(clock),
    )
    assert.equal(run.states.t, 'pass')
  })

  test('an aroundAll setup that outlasts the timeout fails the suite', async () => {
    const started = Promise.withResolvers<void>()
    const running = runScript(
      ({ describe, test, aroundAll }) => {
        describe('a', () => {
          aroundAll(async () => {
            started.resolve()
            await hang()
          }, 100)
          test('t', () => {})
        })
      },
      {},
      clockOptions(clock),
    )
    await reached(started.promise, running)
    await clock.tickAsync(100)
    const run = await running
    assert.equal(run.suites.a?.errors[0]?.name, 'AroundHookSetupError')
    assert.equal(run.states['a > t'], 'skip')
  })

  test('a timer is left running only while a phase is open', async () => {
    const run: Script = ({ test, aroundEach }) => {
      aroundEach(async (runTest) => {
        await runTest()
      }, 100)
      test('t', () => {})
    }
    await runScript(run, {}, clockOptions(clock))
    assert.equal(clock.countTimers(), 0)
  })

  test('a phase timer does not hold the process open', async () => {
    const started = Promise.withResolvers<void>()
    const tracked = trackRefs(timersOf(clock))
    const running = runScript(
      ({ test, aroundEach }) => {
        aroundEach(async () => {
          started.resolve()
          await hang()
        }, 100)
        test('t', () => {})
      },
      {},
      { realTimers: tracked.timers, now: () => clock.now },
    )
    await reached(started.promise, running)
    assert.equal(tracked.created(), 1)
    assert.equal(tracked.refed(), 0)
    await clock.tickAsync(100)
    await running
  })

  test('a hook that does not await runTest leaves no timer behind, and never aborts the finished test', async () => {
    const bodyDone = Promise.withResolvers<void>()
    let signal: AbortSignal | undefined
    const running = runScript(
      ({ test, aroundEach }) => {
        aroundEach((runTest) => {
          void runTest()
        }, 100)
        test('t', (ctx) => {
          signal = ctx.signal
          bodyDone.resolve()
        })
      },
      {},
      clockOptions(clock),
    )
    await running
    // The body runs on after the hook has returned; give it, and what follows it, time to end.
    await Promise.race([bodyDone.promise, settle().then(settle).then(settle)])
    await settle()
    assert.ok(signal)
    assert.equal(clock.countTimers(), 0)
    await clock.tickAsync(100)
    assert.equal(signal.aborted, false)
  })
})

describe('LazyHost teardowns added in aroundEach', () => {
  test('one added before runTest runs after the hook has finished, the body ones before it', async () => {
    const run = await runScript(({ test, aroundEach }, step, runtime) => {
      aroundEach(async (runTest, ctx) => {
        runtime.lazyHost.runOf(ctx)?.addTeardown(() => step('around teardown'))
        await runTest()
        step('around hook after runTest')
      })
      test('t', (ctx) => {
        runtime.lazyHost.runOf(ctx)?.addTeardown(() => step('body teardown'))
        step('body')
      })
    })
    assert.deepEqual(run.trace, [
      'body',
      'body teardown',
      'around hook after runTest',
      'around teardown',
    ])
  })

  test('one added by a hook that then throws before runTest still runs', async () => {
    const run = await runScript(({ test, aroundEach }, step, runtime) => {
      aroundEach((_runTest, ctx) => {
        runtime.lazyHost.runOf(ctx)?.addTeardown(() => step('teardown'))
        throw new Error('setup failed')
      })
      test('t', () => step('body'))
    })
    assert.deepEqual(run.trace, ['teardown'])
    assert.equal(run.states.t, 'fail')
  })

  test('one added after runTest returned still runs, in the cleanup state', async () => {
    let state: string | undefined
    const run = await runScript(({ test, aroundEach }, step, runtime) => {
      aroundEach(async (runTest, ctx) => {
        await runTest()
        const handle = runtime.lazyHost.runOf(ctx)
        handle?.addTeardown(() => {
          state = handle.state
          step('teardown')
        })
      })
      test('t', () => {})
    })
    assert.deepEqual(run.trace, ['teardown'])
    assert.equal(state, 'cleanup')
  })

  test('one that throws fails the test', async () => {
    const run = await runScript(({ test, aroundEach }, _step, runtime) => {
      aroundEach(async (runTest, ctx) => {
        runtime.lazyHost.runOf(ctx)?.addTeardown(() => {
          throw new Error('teardown failed')
        })
        await runTest()
      })
      test('t', () => {})
    })
    assert.deepEqual(run.errors.t, ['teardown failed'])
  })
})
