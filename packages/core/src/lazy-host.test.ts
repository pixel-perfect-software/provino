// The executor's side of `LazyHost`: the four guarantees in `lazy-host.ts`'s header, and the rest
// of the host (`collecting`, `addHook`, `onCollected`, `runOf`, worker teardowns and slots).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LazyFrame, SuiteHandle, TestContext, TestRunHandle } from '@provino/types'
import { eventsOf, runScript } from './internal/test-support.ts'

/** The frame of a test, or a failed assertion. */
function testFrame(frame: LazyFrame | undefined): Extract<LazyFrame, { kind: 'test' }> {
  assert.equal(frame?.kind, 'test')
  return frame as Extract<LazyFrame, { kind: 'test' }>
}

describe('guarantee 1: one frame and one slots map per attempt', () => {
  test('the each-hooks of every level, the body and the teardowns all see the same frame', async () => {
    const seen = new Map<string, LazyFrame | undefined>()
    await runScript(({ describe, test, beforeEach, afterEach }, _step, runtime) => {
      const take = (phase: string): void => {
        seen.set(phase, runtime.lazyHost.current())
      }
      beforeEach(() => take('root beforeEach'))
      afterEach(() => take('root afterEach'))
      describe('a', () => {
        beforeEach(() => take('a beforeEach'))
        afterEach(() => take('a afterEach'))
        test('t', () => {
          take('body')
          testFrame(runtime.lazyHost.current()).run.addTeardown(() => take('teardown'))
        })
      })
    })
    const body = testFrame(seen.get('body'))
    assert.deepEqual(
      [...seen.keys()],
      ['root beforeEach', 'a beforeEach', 'body', 'a afterEach', 'root afterEach', 'teardown'],
    )
    for (const [phase, frame] of seen) {
      assert.equal(frame, body, phase)
      assert.equal(testFrame(frame).run.slots, body.run.slots, phase)
    }
  })

  test('a value stored in slots by a beforeEach is there in the body and the teardown', async () => {
    const key = Symbol('value')
    const seen: unknown[] = []
    await runScript(({ test, beforeEach }, _step, runtime) => {
      beforeEach(() => {
        testFrame(runtime.lazyHost.current()).run.slots.set(key, 'from beforeEach')
      })
      test('t', () => {
        const { run } = testFrame(runtime.lazyHost.current())
        seen.push(run.slots.get(key))
        run.addTeardown(() => seen.push(run.slots.get(key)))
      })
    })
    assert.deepEqual(seen, ['from beforeEach', 'from beforeEach'])
  })

  test('two tests do not share a frame or slots', async () => {
    const frames: LazyFrame[] = []
    await runScript(({ test }, _step, runtime) => {
      for (const name of ['one', 'two']) {
        test(name, () => {
          const frame = runtime.lazyHost.current()
          assert.ok(frame)
          frames.push(frame)
        })
      }
    })
    const [one, two] = frames.map(testFrame)
    assert.notEqual(one, two)
    assert.notEqual(one?.run.slots, two?.run.slots)
  })

  test('a beforeAll and an afterAll each get a suite frame, for the suite they are declared on', async () => {
    const seen: Record<string, LazyFrame | undefined> = {}
    await runScript(({ describe, test, beforeAll, afterAll }, _step, runtime) => {
      describe('a', () => {
        beforeAll(() => {
          seen.beforeAll = runtime.lazyHost.current()
        })
        afterAll(() => {
          seen.afterAll = runtime.lazyHost.current()
        })
        describe('b', () => {
          test('t', () => {})
        })
      })
    })
    for (const hook of ['beforeAll', 'afterAll'] as const) {
      const frame = seen[hook]
      assert.equal(frame?.kind, 'suite')
      assert.equal(frame?.kind === 'suite' && frame.hook, hook)
      assert.equal(frame?.suite.name, 'a')
    }
  })

  test('there is no lazy frame outside a test or a suite hook', async () => {
    const seen: Array<LazyFrame | undefined> = []
    const run = await runScript(({ test }, _step, runtime) => {
      seen.push(runtime.lazyHost.current())
      test('t', () => {})
    })
    seen.push(run.runtime.lazyHost.current())
    assert.deepEqual(seen, [undefined, undefined])
  })
})

describe('guarantee 2: frame.suite is the innermost suite', () => {
  test('a beforeEach of an outer suite sees the suite of the test, not its own', async () => {
    const seen: Array<[string, string]> = []
    await runScript(({ describe, test, beforeEach, afterEach }, _step, runtime) => {
      const take = (phase: string): void => {
        seen.push([phase, testFrame(runtime.lazyHost.current()).suite.name])
      }
      beforeEach(() => take('file beforeEach'))
      describe('outer', () => {
        beforeEach(() => take('outer beforeEach'))
        describe('inner', () => {
          afterEach(() => take('inner afterEach'))
          test('t', () => take('body'))
        })
        afterEach(() => take('outer afterEach'))
      })
    })
    assert.deepEqual(seen, [
      ['file beforeEach', 'inner'],
      ['outer beforeEach', 'inner'],
      ['body', 'inner'],
      ['inner afterEach', 'inner'],
      ['outer afterEach', 'inner'],
    ])
  })

  test('is the same handle as the suite of the test run', async () => {
    let frame: LazyFrame | undefined
    await runScript(({ describe, test }, _step, runtime) => {
      describe('a', () => {
        test('t', () => {
          frame = runtime.lazyHost.current()
        })
      })
    })
    const { suite, run } = testFrame(frame)
    assert.equal(run.test.suite, suite)
  })

  test('for a test directly in the file, it is the file root', async () => {
    let frame: LazyFrame | undefined
    await runScript(({ test }, _step, runtime) => {
      test('t', () => {
        frame = runtime.lazyHost.current()
      })
    })
    assert.equal(testFrame(frame).suite.name, 'script.test.ts')
    assert.equal(testFrame(frame).suite.parent, undefined)
  })
})

describe('guarantee 3: teardowns run after afterEach, in the cleanup state', () => {
  test('a run teardown follows the afterEach hooks, and sees the state "cleanup"', async () => {
    const states: Array<[string, TestRunHandle['state']]> = []
    let handle: TestRunHandle | undefined
    const run = await runScript(({ test, beforeEach, afterEach }, step, runtime) => {
      const take = (phase: string): void => {
        const { run: current } = testFrame(runtime.lazyHost.current())
        handle = current
        states.push([phase, current.state])
        step(phase)
      }
      beforeEach(() => take('beforeEach'))
      afterEach(() => take('afterEach'))
      test('t', () => {
        take('body')
        testFrame(runtime.lazyHost.current()).run.addTeardown(() => take('teardown'))
      })
    })
    assert.deepEqual(run.trace, ['beforeEach', 'body', 'afterEach', 'teardown'])
    assert.deepEqual(states, [
      ['beforeEach', 'running'],
      ['body', 'running'],
      ['afterEach', 'running'],
      ['teardown', 'cleanup'],
    ])
    assert.equal(handle?.state, 'done')
  })

  test('teardowns run last added first', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      test('t', () => {
        const { run: current } = testFrame(runtime.lazyHost.current())
        current.addTeardown(() => step('first added'))
        current.addTeardown(() => step('second added'))
      })
    })
    assert.deepEqual(run.trace, ['second added', 'first added'])
  })

  test('a teardown that throws fails the test, and the later teardowns still run', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      test('t', () => {
        const { run: current } = testFrame(runtime.lazyHost.current())
        current.addTeardown(() => step('runs last'))
        current.addTeardown(() => {
          throw new Error('teardown failed')
        })
      })
    })
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.errors.t, ['teardown failed'])
    assert.deepEqual(run.trace, ['runs last'])
  })

  test('a teardown can still read the frame of its test', async () => {
    let inTeardown: LazyFrame | undefined
    let inBody: LazyFrame | undefined
    await runScript(({ test }, _step, runtime) => {
      test('t', () => {
        inBody = runtime.lazyHost.current()
        testFrame(inBody).run.addTeardown(() => {
          inTeardown = runtime.lazyHost.current()
        })
      })
    })
    assert.equal(inTeardown, inBody)
  })
})

describe('guarantee 4: fresh slots for every attempt', () => {
  test('a retry and a repeat each start with an empty slots map of their own', async () => {
    const maps: Array<TestRunHandle['slots']> = []
    const sizesOnEntry: number[] = []
    const attempts: Array<[number, number]> = []
    await runScript(({ test }, _step, runtime) => {
      let calls = 0
      test('t', { retry: 1, repeats: 1 }, () => {
        const { run } = testFrame(runtime.lazyHost.current())
        maps.push(run.slots)
        sizesOnEntry.push(run.slots.size)
        attempts.push([run.ctx.task.retry, run.ctx.task.repeat])
        run.slots.set(Symbol('memo'), calls)
        // The first attempt of each repeat fails, so it is retried.
        if (++calls % 2 === 1) throw new Error('fail')
      })
    })
    assert.equal(new Set(maps).size, 4)
    assert.deepEqual(sizesOnEntry, [0, 0, 0, 0])
    assert.deepEqual(attempts, [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ])
  })

  test('a retry gets a new run handle, and the old one is done', async () => {
    const handles: TestRunHandle[] = []
    await runScript(({ test }, _step, runtime) => {
      test('t', { retry: 1 }, () => {
        handles.push(testFrame(runtime.lazyHost.current()).run)
        if (handles.length === 1) throw new Error('fail')
      })
    })
    const [first, second] = handles
    assert.notEqual(first, second)
    assert.equal(first?.state, 'done')
    assert.equal(second?.state, 'done')
  })
})

describe('runOf', () => {
  test('gives the run of a context, the same one in the hooks and the body', async () => {
    const runs: Array<TestRunHandle | undefined> = []
    await runScript(({ test, beforeEach }, _step, runtime) => {
      beforeEach((ctx) => {
        runs.push(runtime.lazyHost.runOf(ctx))
      })
      test('t', (ctx) => {
        runs.push(runtime.lazyHost.runOf(ctx))
        runs.push(testFrame(runtime.lazyHost.current()).run)
      })
    })
    assert.ok(runs[0])
    assert.deepEqual(new Set(runs).size, 1)
  })

  test('describes the test: its name, full name, file, retry and repeat', async () => {
    let task: TestRunHandle['ctx']['task'] | undefined
    await runScript(
      ({ describe, test }, _step, runtime) => {
        describe('a', () => {
          test('t', (ctx) => {
            task = runtime.lazyHost.runOf(ctx)?.ctx.task
          })
        })
      },
      { nameSeparator: ' / ' },
    )
    assert.deepEqual(task, {
      name: 't',
      fullName: 'a / t',
      file: 'script.test.ts',
      retry: 0,
      repeat: 0,
    })
  })

  test('hands over the signal of the context, and the suite of the test', async () => {
    let seen: { signal: AbortSignal; ctx: TestContext; suite: SuiteHandle } | undefined
    await runScript(({ describe, test }, _step, runtime) => {
      describe('a', () => {
        test('t', (ctx) => {
          const run = runtime.lazyHost.runOf(ctx)
          assert.ok(run)
          seen = { signal: run.signal, ctx, suite: run.test.suite }
        })
      })
    })
    assert.equal(seen?.signal, seen?.ctx.signal)
    assert.equal(seen?.suite.name, 'a')
  })

  test('is undefined for an object that is not a test context', async () => {
    const run = await runScript(({ test }) => {
      test('t', () => {})
    })
    assert.equal(run.runtime.lazyHost.runOf({}), undefined)
  })

  test('still answers after the test has ended, with the state "done"', async () => {
    let context: TestContext | undefined
    const run = await runScript(({ test }) => {
      test('t', (ctx) => {
        context = ctx
      })
    })
    assert.equal(run.runtime.lazyHost.runOf(context as object)?.state, 'done')
  })
})

describe('collecting', () => {
  test('is the suite whose body or file top level is registering now', async () => {
    const seen: Array<[string, string | undefined]> = []
    await runScript(({ describe, test }, _step, runtime) => {
      const take = (where: string): void => {
        seen.push([where, runtime.lazyHost.collecting()?.name])
      }
      take('top')
      describe('d', () => {
        take('d body')
        describe('e', () => take('e body'))
        take('d body again')
        test('t', () => {})
      })
      take('top again')
    })
    assert.deepEqual(seen, [
      ['top', 'script.test.ts'],
      ['d body', 'd'],
      ['e body', 'e'],
      ['d body again', 'd'],
      ['top again', 'script.test.ts'],
    ])
  })

  test('is the suite after an await in an async body', async () => {
    let seen: string | undefined
    await runScript(
      ({ describe, test }, _step, runtime) => {
        describe('d', async () => {
          await Promise.resolve()
          seen = runtime.lazyHost.collecting()?.name
          test('t', () => {})
        })
      },
      { asyncDescribe: 'await' },
    )
    assert.equal(seen, 'd')
  })

  test('is the suite in a deferred body', async () => {
    let seen: string | undefined
    await runScript(
      ({ describe, test }, _step, runtime) => {
        describe('d', () => {
          seen = runtime.lazyHost.collecting()?.name
          test('t', () => {})
        })
      },
      { collect: { describeBody: 'deferred' } },
    )
    assert.equal(seen, 'd')
  })

  test('is undefined in a test, in a hook, and after the file has run', async () => {
    const seen: Array<[string, SuiteHandle | undefined]> = []
    const run = await runScript(({ test, beforeAll, beforeEach }, _step, runtime) => {
      beforeAll(() => {
        seen.push(['beforeAll', runtime.lazyHost.collecting()])
      })
      beforeEach(() => {
        seen.push(['beforeEach', runtime.lazyHost.collecting()])
      })
      test('t', () => {
        seen.push(['body', runtime.lazyHost.collecting()])
      })
    })
    assert.deepEqual(seen, [
      ['beforeAll', undefined],
      ['beforeEach', undefined],
      ['body', undefined],
    ])
    assert.equal(run.runtime.lazyHost.collecting(), undefined)
  })
})

describe('addHook', () => {
  test('adds a hook after the ones declared so far and before the ones declared later', async () => {
    const run = await runScript(({ describe, test, beforeAll, beforeEach }, step, runtime) => {
      describe('d', () => {
        beforeEach(() => step('declared first'))
        const suite = runtime.lazyHost.collecting()
        assert.ok(suite)
        runtime.lazyHost.addHook(suite, 'beforeEach', () => step('added'))
        beforeEach(() => step('declared last'))
        runtime.lazyHost.addHook(suite, 'beforeAll', () => step('added beforeAll'))
        beforeAll(() => step('declared beforeAll'))
        test('t', () => step('body'))
      })
    })
    assert.deepEqual(run.trace, [
      'added beforeAll',
      'declared beforeAll',
      'declared first',
      'added',
      'declared last',
      'body',
    ])
  })

  test('can add to the file root from the top level', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      const root = runtime.lazyHost.collecting()
      assert.ok(root)
      runtime.lazyHost.addHook(root, 'beforeEach', () => step('root hook'))
      test('t', () => step('body'))
    })
    assert.deepEqual(run.trace, ['root hook', 'body'])
  })

  test('an added hook is reported like any hook, with its index among the suite hooks and no location', async () => {
    const run = await runScript(
      ({ test, beforeEach }, _step, runtime) => {
        beforeEach(() => {})
        const root = runtime.lazyHost.collecting()
        assert.ok(root)
        runtime.lazyHost.addHook(root, 'beforeEach', () => {})
        test('t', () => {})
      },
      {},
      { locations: true },
    )
    const starts = eventsOf(run.events, 'hook-start').filter((event) => event.kind === 'beforeEach')
    assert.deepEqual(
      starts.map((event) => [event.ordinal, event.location === null]),
      [
        [0, false],
        [1, true],
      ],
    )
  })

  test('throws CORE_INVALID_ARGUMENT for a suite that is not in the file being collected', async () => {
    let stale: SuiteHandle | undefined
    let error: unknown
    let calls = 0
    const run = await runScript(({ test }, _step, runtime) => {
      calls++
      if (calls === 1) {
        stale = runtime.lazyHost.collecting()
        test('t', () => {})
        return
      }
      try {
        assert.ok(stale)
        runtime.lazyHost.addHook(stale, 'beforeEach', () => {})
      } catch (thrown) {
        error = thrown
      }
    })
    await run.runtime.runFile('/project/second.test.ts')
    assert.equal((error as { code?: string }).code, 'CORE_INVALID_ARGUMENT')
    assert.ok(stale)
    assert.throws(() => run.runtime.lazyHost.addHook(stale as SuiteHandle, 'beforeAll', () => {}), {
      code: 'CORE_INVALID_ARGUMENT',
    })
  })
})

describe('onCollected', () => {
  test('is called once, after the whole file has been collected and before any hook or test runs', async () => {
    const run = await runScript(({ test, beforeAll }, step, runtime) => {
      step('top')
      runtime.lazyHost.onCollected((file) => step(`collected ${file.name}`))
      beforeAll(() => step('beforeAll'))
      test('t', () => step('body'))
      step('end of file')
    })
    assert.deepEqual(run.trace, [
      'top',
      'end of file',
      'collected script.test.ts',
      'beforeAll',
      'body',
    ])
  })

  test('calls each registered callback, in the order they were registered', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      runtime.lazyHost.onCollected(() => step('first'))
      runtime.lazyHost.onCollected(() => step('second'))
      test('t', () => {})
    })
    assert.deepEqual(run.trace, ['first', 'second'])
  })

  test('hands the callback the file handle: its root suite and a signal', async () => {
    let seen: { root: string; signal: boolean } | undefined
    await runScript(({ test }, _step, runtime) => {
      runtime.lazyHost.onCollected((file) => {
        seen = { root: file.root.name, signal: file.signal instanceof AbortSignal }
      })
      test('t', () => {})
    })
    assert.deepEqual(seen, { root: 'script.test.ts', signal: true })
  })

  test('is not called again for a second file', async () => {
    let calls = 0
    const run = await runScript(({ test }, step, runtime) => {
      if (++calls === 1) runtime.lazyHost.onCollected(() => step('collected'))
      test('t', () => {})
    })
    await run.runtime.runFile('/project/second.test.ts')
    assert.deepEqual(run.trace, ['collected'])
  })

  test('throws CORE_INVALID_ARGUMENT once collection is over', async () => {
    const run = await runScript(({ test, beforeAll }, _step, runtime) => {
      beforeAll(() => runtime.lazyHost.onCollected(() => {}))
      test('t', () => {})
    })
    assert.equal(run.results.t?.errors[0]?.code, 'CORE_INVALID_ARGUMENT')
    assert.throws(() => run.runtime.lazyHost.onCollected(() => {}), {
      code: 'CORE_INVALID_ARGUMENT',
    })
  })
})

describe('worker teardowns and slots', () => {
  test('worker teardowns wait for dispose, then run last added first', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      runtime.lazyHost.addWorkerTeardown(() => step('first added'))
      runtime.lazyHost.addWorkerTeardown(async () => {
        await Promise.resolve()
        step('second added')
      })
      test('t', () => {})
    })
    assert.deepEqual(run.trace, [])
    await run.runtime.dispose()
    assert.deepEqual(run.trace, ['second added', 'first added'])
  })

  test('a worker teardown outlives the file that added it', async () => {
    let calls = 0
    const run = await runScript(({ test }, step, runtime) => {
      if (++calls === 1) runtime.lazyHost.addWorkerTeardown(() => step('teardown'))
      test('t', () => {})
    })
    await run.runtime.runFile('/project/second.test.ts')
    assert.deepEqual(run.trace, [])
    await run.runtime.dispose()
    assert.deepEqual(run.trace, ['teardown'])
  })

  test('dispose runs every teardown even when some fail, then rejects with an AggregateError of them', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      runtime.lazyHost.addWorkerTeardown(() => step('ran first added'))
      runtime.lazyHost.addWorkerTeardown(() => {
        throw new Error('middle failed')
      })
      runtime.lazyHost.addWorkerTeardown(() => {
        throw new Error('last failed')
      })
      test('t', () => {})
    })
    await assert.rejects(run.runtime.dispose(), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(
        error.errors.map((inner: Error) => inner.message),
        ['last failed', 'middle failed'],
      )
      return true
    })
    assert.deepEqual(run.trace, ['ran first added'])
  })

  test('dispose has nothing left to run the second time', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      runtime.lazyHost.addWorkerTeardown(() => step('teardown'))
      test('t', () => {})
    })
    await run.runtime.dispose()
    await run.runtime.dispose()
    assert.deepEqual(run.trace, ['teardown'])
  })

  test('workerSlots is one map for the runtime, and keeps its values between files', async () => {
    const key = Symbol('shared')
    const seen: unknown[] = []
    let calls = 0
    const run = await runScript(({ test }, _step, runtime) => {
      if (++calls === 1) runtime.lazyHost.workerSlots.set(key, 'set in the first file')
      else seen.push(runtime.lazyHost.workerSlots.get(key))
      test('t', () => {})
    })
    await run.runtime.runFile('/project/second.test.ts')
    assert.deepEqual(seen, ['set in the first file'])
    assert.equal(run.runtime.lazyHost.workerSlots, run.runtime.lazyHost.workerSlots)
  })

  test('two runtimes do not share worker slots', async () => {
    const one = await runScript(() => {})
    const two = await runScript(() => {})
    assert.notEqual(one.runtime.lazyHost.workerSlots, two.runtime.lazyHost.workerSlots)
  })
})
