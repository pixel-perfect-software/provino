// T5.6 acceptance, part 1: hook order, hook failure policies, hook-returned cleanup, skipped
// blocks and the event protocol. Timeouts, concurrency, retries, around hooks, `done` and the
// per-test callbacks have their own files. Each policy value is set alone over the neutral base.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { HookKind, OrderHooks } from '@provino/types'
import {
  eventLog,
  eventsOf,
  loaderWithOrderHooks,
  ORDER_HOOKS_REF,
  reached,
  runScript,
  type Script,
  settle,
} from '../internal/test-support.ts'

const KINDS = ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'] as const satisfies HookKind[]

/** Two hooks of every kind on the file and on describe `a`, which holds one test. */
const twoLevels: Script = (api, step) => {
  const register = (level: string): void => {
    for (const kind of KINDS) {
      for (const n of [1, 2]) api[kind](() => step(`${kind} ${level}${n}`))
    }
  }
  register('r')
  api.describe('a', () => {
    register('a')
    api.test('t', () => step('body'))
  })
}

/** The steps of one hook kind, in the order they ran. */
const only = (trace: readonly string[], kind: HookKind): string[] =>
  trace.filter((step) => step.startsWith(`${kind} `))

describe('hookOrder', () => {
  const expected = {
    beforeAll: {
      declaration: ['beforeAll r1', 'beforeAll r2', 'beforeAll a1', 'beforeAll a2'],
      reverse: ['beforeAll r2', 'beforeAll r1', 'beforeAll a2', 'beforeAll a1'],
    },
    beforeEach: {
      declaration: ['beforeEach r1', 'beforeEach r2', 'beforeEach a1', 'beforeEach a2'],
      reverse: ['beforeEach r2', 'beforeEach r1', 'beforeEach a2', 'beforeEach a1'],
    },
    afterEach: {
      declaration: ['afterEach a1', 'afterEach a2', 'afterEach r1', 'afterEach r2'],
      reverse: ['afterEach a2', 'afterEach a1', 'afterEach r2', 'afterEach r1'],
    },
    afterAll: {
      declaration: ['afterAll a1', 'afterAll a2', 'afterAll r1', 'afterAll r2'],
      reverse: ['afterAll a2', 'afterAll a1', 'afterAll r2', 'afterAll r1'],
    },
  } as const

  for (const kind of KINDS) {
    for (const order of ['declaration', 'reverse'] as const) {
      test(`${order} runs a level's ${kind} hooks in that order, the levels still outer-in or inner-out`, async () => {
        const run = await runScript(twoLevels, { hookOrder: { [kind]: order } })
        assert.deepEqual(only(run.trace, kind), expected[kind][order])
      })
    }
  }

  /**
   * Starts a test whose two hooks of `kind` each wait for a gate. Returns which hooks had started
   * once everything that could run had run, then lets them all finish.
   */
  async function startedHooks(
    kind: HookKind,
    overrides: Parameters<typeof runScript>[1],
    options: Parameters<typeof runScript>[2] = {},
  ): Promise<string[]> {
    const started: string[] = []
    const gate = Promise.withResolvers<void>()
    const first = Promise.withResolvers<void>()
    const hook = (name: string) => async (): Promise<void> => {
      started.push(name)
      first.resolve()
      await gate.promise
    }
    const running = runScript(
      (api) => {
        api[kind](hook('1'))
        api[kind](hook('2'))
        api.test('t', () => {})
      },
      overrides,
      options,
    )
    try {
      await reached(first.promise, running)
      await settle()
      return [...started]
    } finally {
      gate.resolve()
      await running
    }
  }

  for (const kind of KINDS) {
    test(`declaration runs one ${kind} hook at a time`, async () => {
      assert.deepEqual(await startedHooks(kind, { hookOrder: { [kind]: 'declaration' } }), ['1'])
    })

    test(`parallel starts every ${kind} hook of a level before any has finished`, async () => {
      assert.deepEqual(await startedHooks(kind, { hookOrder: { [kind]: 'parallel' } }), ['1', '2'])
    })
  }

  test('parallel also runs the cleanups hooks returned together', async () => {
    const started: string[] = []
    const gate = Promise.withResolvers<void>()
    const first = Promise.withResolvers<void>()
    const cleanup = (name: string) => async (): Promise<void> => {
      started.push(name)
      first.resolve()
      await gate.promise
    }
    const running = runScript(
      ({ beforeEach, test }) => {
        beforeEach(() => cleanup('1'))
        beforeEach(() => cleanup('2'))
        test('t', () => {})
      },
      { hookOrder: { afterEach: 'parallel' } },
    )
    try {
      await reached(first.promise, running)
      await settle()
      assert.deepEqual(started, ['1', '2'])
    } finally {
      gate.resolve()
      await running
    }
  })
})

describe('orderHooks', () => {
  const orderHooks: OrderHooks = (hooks, kind) =>
    kind === 'beforeEach' ? hooks.toReversed() : hooks
  const behaviours = loaderWithOrderHooks(orderHooks)

  test('orders the hooks of the kind it reorders', async () => {
    const run = await runScript(twoLevels, { orderHooks: ORDER_HOOKS_REF }, { behaviours })
    assert.deepEqual(only(run.trace, 'beforeEach'), [
      'beforeEach r2',
      'beforeEach r1',
      'beforeEach a2',
      'beforeEach a1',
    ])
  })

  test('wins over hookOrder: a kind it leaves alone runs in declaration order', async () => {
    const run = await runScript(
      twoLevels,
      { orderHooks: ORDER_HOOKS_REF, hookOrder: { afterEach: 'reverse', afterAll: 'reverse' } },
      { behaviours },
    )
    assert.deepEqual(only(run.trace, 'afterEach'), expectedDeclaration('afterEach'))
    assert.deepEqual(only(run.trace, 'afterAll'), expectedDeclaration('afterAll'))
  })

  test('is asked once per level and kind, with the hooks of that level', async () => {
    const calls: Array<readonly [HookKind, number]> = []
    const run = await runScript(
      twoLevels,
      { orderHooks: ORDER_HOOKS_REF },
      {
        behaviours: loaderWithOrderHooks((hooks, kind) => {
          calls.push([kind, hooks.length])
          return hooks
        }),
      },
    )
    assert.equal(run.file.state, 'pass')
    for (const kind of KINDS) {
      assert.deepEqual(
        calls.filter(([asked]) => asked === kind),
        [
          [kind, 2],
          [kind, 2],
        ],
      )
    }
  })

  test('turns off parallel: hooks run one at a time even where hookOrder says parallel', async () => {
    const started: string[] = []
    const gate = Promise.withResolvers<void>()
    const first = Promise.withResolvers<void>()
    const hook = (name: string) => async (): Promise<void> => {
      started.push(name)
      first.resolve()
      await gate.promise
    }
    const running = runScript(
      ({ beforeEach, test }) => {
        beforeEach(hook('1'))
        beforeEach(hook('2'))
        test('t', () => {})
      },
      { orderHooks: ORDER_HOOKS_REF, hookOrder: { beforeEach: 'parallel' } },
      { behaviours: loaderWithOrderHooks((hooks) => hooks) },
    )
    try {
      await reached(first.promise, running)
      await settle()
      assert.deepEqual(started, ['1'])
    } finally {
      gate.resolve()
      await running
    }
  })

  function expectedDeclaration(kind: 'afterEach' | 'afterAll'): string[] {
    return [`${kind} a1`, `${kind} a2`, `${kind} r1`, `${kind} r2`]
  }
})

describe('eachHooksForConcurrent', () => {
  const script: Script = ({ test, beforeAll, beforeEach, afterEach }, step) => {
    beforeAll(() => step('beforeAll'))
    beforeEach((ctx) => step(`beforeEach ${ctx.task.name}`))
    afterEach((ctx) => step(`afterEach ${ctx.task.name}`))
    test.concurrent('concurrent', () => {})
    test('sequential', () => {})
  }

  test('true runs the each-hooks around a concurrent test', async () => {
    const run = await runScript(script, { eachHooksForConcurrent: true })
    assert.deepEqual(run.trace, [
      'beforeAll',
      'beforeEach concurrent',
      'afterEach concurrent',
      'beforeEach sequential',
      'afterEach sequential',
    ])
  })

  test('false skips the each-hooks for a concurrent test only', async () => {
    const run = await runScript(script, { eachHooksForConcurrent: false })
    assert.deepEqual(run.trace, ['beforeAll', 'beforeEach sequential', 'afterEach sequential'])
  })

  test('false never runs a hook-returned cleanup for a concurrent test, as its hook never ran', async () => {
    const run = await runScript(
      ({ test, beforeEach }, step) => {
        beforeEach(() => () => step('cleanup'))
        test.concurrent('concurrent', () => step('body'))
      },
      { eachHooksForConcurrent: false },
    )
    assert.deepEqual(run.trace, ['body'])
    assert.equal(run.states.concurrent, 'pass')
  })
})

describe('hookReturnsCleanup', () => {
  const script: Script = ({ describe, test, beforeEach, afterEach }, step) => {
    beforeEach(() => () => step('cleanup r'))
    afterEach(() => step('afterEach r'))
    describe('a', () => {
      beforeEach(() => () => step('cleanup a'))
      afterEach(() => step('afterEach a'))
      test('t', () => step('body'))
    })
  }

  test('true runs the returned function after every level has run its afterEach hooks', async () => {
    const run = await runScript(script, { hookReturnsCleanup: true })
    assert.deepEqual(run.trace, ['body', 'afterEach a', 'afterEach r', 'cleanup a', 'cleanup r'])
  })

  test('true runs the cleanups in the order of hookOrder.afterEach: declaration', async () => {
    const run = await runScript(script, {
      hookReturnsCleanup: true,
      hookOrder: { afterEach: 'declaration' },
    })
    assert.deepEqual(run.trace.slice(-2), ['cleanup r', 'cleanup a'])
  })

  test('false ignores what a hook returns', async () => {
    const run = await runScript(script, { hookReturnsCleanup: false })
    assert.deepEqual(run.trace, ['body', 'afterEach a', 'afterEach r'])
  })

  test('true ignores a return value that is not a function', async () => {
    const run = await runScript(
      ({ test, beforeEach }) => {
        beforeEach(() => 'not a function')
        test('t', () => {})
      },
      { hookReturnsCleanup: true },
    )
    assert.equal(run.states.t, 'pass')
  })

  test('true runs a beforeAll cleanup after the suite afterAll hooks', async () => {
    const run = await runScript(
      ({ describe, test, beforeAll, afterAll }, step) => {
        describe('a', () => {
          beforeAll(() => () => step('cleanup'))
          afterAll(() => step('afterAll'))
          test('t', () => step('body'))
        })
      },
      { hookReturnsCleanup: true },
    )
    assert.deepEqual(run.trace, ['body', 'afterAll', 'cleanup'])
  })

  test('a cleanup that throws fails the test', async () => {
    const run = await runScript(
      ({ test, beforeEach }) => {
        beforeEach(() => () => {
          throw new Error('cleanup failed')
        })
        test('t', () => {})
      },
      { hookReturnsCleanup: true },
    )
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.errors.t, ['cleanup failed'])
  })

  test('is reported as a teardown hook, owned by the hook it came from', async () => {
    const run = await runScript(script, { hookReturnsCleanup: true })
    assert.ok(
      eventLog(run).includes('hook-start teardown#0 owner=a test=a > t'),
      eventLog(run).join('\n'),
    )
  })
})

describe('hooks.afterError', () => {
  const afterEachScript: Script = ({ describe, test, beforeEach, afterEach }, step) => {
    beforeEach(() => () => step('teardown'))
    describe('a', () => {
      afterEach(() => {
        step('a1')
        throw new Error('a1 failed')
      })
      afterEach(() => step('a2'))
      test('t', () => step('body'))
    })
    afterEach(() => step('r1'))
  }

  test('continue runs the rest of the afterEach hooks and the cleanups after one fails', async () => {
    const run = await runScript(afterEachScript, {
      hooks: { afterError: 'continue' },
      hookOrder: { afterEach: 'declaration' },
    })
    assert.deepEqual(run.trace, ['body', 'a1', 'a2', 'r1', 'teardown'])
    assert.equal(run.states['a > t'], 'fail')
    assert.deepEqual(run.errors['a > t'], ['a1 failed'])
  })

  test('abort-chain stops at the failing afterEach hook, skipping the rest and the cleanups', async () => {
    const run = await runScript(afterEachScript, {
      hooks: { afterError: 'abort-chain' },
      hookOrder: { afterEach: 'declaration' },
    })
    assert.deepEqual(run.trace, ['body', 'a1'])
    assert.equal(run.states['a > t'], 'fail')
    assert.deepEqual(run.errors['a > t'], ['a1 failed'])
  })

  const afterAllScript: Script = ({ describe, test, beforeAll, afterAll }, step) => {
    describe('a', () => {
      beforeAll(() => () => step('teardown'))
      afterAll(() => {
        step('a1')
        throw new Error('a1 failed')
      })
      afterAll(() => step('a2'))
      test('t', () => {})
    })
    afterAll(() => step('root afterAll'))
  }

  test('continue runs the rest of the afterAll hooks, the cleanups, and the outer afterAll', async () => {
    const run = await runScript(afterAllScript, {
      hooks: { afterError: 'continue' },
      hookOrder: { afterAll: 'declaration' },
    })
    assert.deepEqual(run.trace, ['a1', 'a2', 'teardown', 'root afterAll'])
  })

  test('abort-chain stops the failing suite afterAll and its cleanups, but not the outer afterAll', async () => {
    const run = await runScript(afterAllScript, {
      hooks: { afterError: 'abort-chain' },
      hookOrder: { afterAll: 'declaration' },
    })
    assert.deepEqual(run.trace, ['a1', 'root afterAll'])
  })
})

describe('hooks.beforeAllError and hooks.nestedHooksAfterBeforeAllError', () => {
  const script: Script = ({ describe, test, beforeAll, beforeEach, afterEach, afterAll }, step) => {
    describe('a', () => {
      beforeAll(() => {
        throw new Error('beforeAll failed')
      })
      beforeEach(() => step('beforeEach a'))
      afterEach(() => step('afterEach a'))
      afterAll(() => step('afterAll a'))
      test('one', () => step('one'))
      test('two', () => step('two'))
      describe('nested', () => {
        beforeAll(() => step('beforeAll nested'))
        test('three', () => step('three'))
      })
    })
    test('after', () => step('after'))
  }

  test('attach-to-tests fails every test below with the beforeAll error, without running a body', async () => {
    const run = await runScript(script, { hooks: { beforeAllError: 'attach-to-tests' } })
    for (const name of ['a > one', 'a > two', 'a > nested > three']) {
      assert.equal(run.states[name], 'fail', name)
      assert.deepEqual(run.errors[name], ['beforeAll failed'], name)
    }
    assert.equal(run.states.after, 'pass')
    assert.ok(!run.trace.includes('one') && !run.trace.includes('three'))
  })

  test('attach-to-tests with nested hooks "run" still runs the afterEach and nested beforeAll hooks', async () => {
    const run = await runScript(script, {
      hooks: { beforeAllError: 'attach-to-tests', nestedHooksAfterBeforeAllError: 'run' },
    })
    assert.deepEqual(run.trace, [
      'afterEach a',
      'afterEach a',
      'beforeAll nested',
      'afterEach a',
      'afterAll a',
      'after',
    ])
  })

  test('attach-to-tests with nested hooks "skip" runs no hook below the failed beforeAll', async () => {
    const run = await runScript(script, {
      hooks: { beforeAllError: 'attach-to-tests', nestedHooksAfterBeforeAllError: 'skip' },
    })
    assert.deepEqual(run.trace, ['afterAll a', 'after'])
  })

  test('skip-subtree skips every test below, and fails the suite with the beforeAll error', async () => {
    const run = await runScript(script, { hooks: { beforeAllError: 'skip-subtree' } })
    for (const name of ['a > one', 'a > two', 'a > nested > three']) {
      assert.equal(run.states[name], 'skip', name)
      assert.equal(run.results[name]?.skipReason, 'unknown', name)
    }
    assert.equal(run.suites.a?.state, 'fail')
    assert.deepEqual(
      run.suites.a?.errors.map((error) => error.message),
      ['beforeAll failed'],
    )
    assert.equal(run.suites['a > nested']?.state, 'skip')
    assert.equal(run.file.state, 'fail')
  })

  test('skip-subtree runs the afterAll of the suite whose beforeAll failed, and nothing nested', async () => {
    const run = await runScript(script, { hooks: { beforeAllError: 'skip-subtree' } })
    assert.deepEqual(run.trace, ['afterAll a', 'after'])
  })
})

describe('hooks.afterAllError', () => {
  const script: Script = ({ describe, test, afterAll }) => {
    describe('a', () => {
      afterAll(() => {
        throw new Error('afterAll failed')
      })
      test('t', () => {})
    })
  }

  test('unhandled leaves the suite and its tests passing, and fails the file', async () => {
    const run = await runScript(script, { hooks: { afterAllError: 'unhandled' } })
    assert.equal(run.states['a > t'], 'pass')
    assert.equal(run.suites.a?.state, 'pass')
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(
      run.file.errors.map((error) => error.message),
      ['afterAll failed'],
    )
  })

  test('fail-suite fails the suite, and the file with it, leaving the tests passing', async () => {
    const run = await runScript(script, { hooks: { afterAllError: 'fail-suite' } })
    assert.equal(run.states['a > t'], 'pass')
    assert.equal(run.suites.a?.state, 'fail')
    assert.deepEqual(
      run.suites.a?.errors.map((error) => error.message),
      ['afterAll failed'],
    )
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(run.file.errors, [])
  })
})

describe('hooks.skippedBlock', () => {
  const blocks: ReadonlyArray<
    readonly [what: string, script: Script, runsBeforeAll: boolean, runsNone: boolean]
  > = [
    [
      'a block whose only test is a todo',
      ({ describe, test, beforeAll, afterAll }, step) => {
        describe('block', () => {
          beforeAll(() => step('beforeAll'))
          afterAll(() => step('afterAll'))
          test.todo('later')
        })
      },
      true,
      false,
    ],
    [
      'a block whose tests are all skipped',
      ({ describe, test, beforeAll, afterAll }, step) => {
        describe('block', () => {
          beforeAll(() => step('beforeAll'))
          afterAll(() => step('afterAll'))
          test.skip('skipped', () => {})
        })
      },
      false,
      false,
    ],
    [
      'a block with no tests',
      ({ describe, beforeAll, afterAll }, step) => {
        describe('block', () => {
          beforeAll(() => step('beforeAll'))
          afterAll(() => step('afterAll'))
        })
      },
      false,
      true,
    ],
    [
      'a block with a test that runs',
      ({ describe, test, beforeAll, afterAll }, step) => {
        describe('block', () => {
          beforeAll(() => step('beforeAll'))
          afterAll(() => step('afterAll'))
          test('t', () => {})
        })
      },
      true,
      true,
    ],
  ]

  for (const [what, script, runsBeforeAll, runsNone] of blocks) {
    test(`run-before-all ${runsBeforeAll ? 'runs' : 'skips'} beforeAll and afterAll for ${what}`, async () => {
      const run = await runScript(script, { hooks: { skippedBlock: 'run-before-all' } })
      assert.deepEqual(run.trace, runsBeforeAll ? ['beforeAll', 'afterAll'] : [])
    })

    test(`none ${runsNone ? 'runs' : 'skips'} beforeAll and afterAll for ${what}`, async () => {
      const run = await runScript(script, { hooks: { skippedBlock: 'none' } })
      assert.deepEqual(run.trace, runsNone ? ['beforeAll', 'afterAll'] : [])
    })
  }

  test('a describe.skip never runs its own hooks, whichever value is set', async () => {
    for (const skippedBlock of ['run-before-all', 'none'] as const) {
      const run = await runScript(
        ({ describe, test, beforeAll }, step) => {
          describe.skip('block', () => {
            beforeAll(() => step('beforeAll'))
            test('t', () => {})
          })
        },
        { hooks: { skippedBlock } },
      )
      assert.deepEqual(run.trace, [], skippedBlock)
    }
  })
})

describe('the event protocol', () => {
  test('one test with hooks emits start and end events in a fixed order, hooks inside the attempt', async () => {
    const run = await runScript(
      ({ describe, test, beforeAll, beforeEach, afterEach, afterAll }) => {
        describe('a', () => {
          beforeAll(() => {})
          beforeEach(() => {})
          afterEach(() => {})
          afterAll(() => {})
          test('t', () => {})
        })
      },
    )
    assert.deepEqual(eventLog(run), [
      'file-collect-start',
      'file-collect-end',
      'suite-start a',
      'hook-start beforeAll#0 owner=a test=-',
      'hook-end beforeAll#0 owner=a test=-',
      'test-start a > t',
      'attempt-start a > t 0/0',
      'hook-start beforeEach#0 owner=a test=a > t',
      'hook-end beforeEach#0 owner=a test=a > t',
      'hook-start afterEach#0 owner=a test=a > t',
      'hook-end afterEach#0 owner=a test=a > t',
      'attempt-end a > t 0/0 pass',
      'test-end a > t pass',
      'hook-start afterAll#0 owner=a test=-',
      'hook-end afterAll#0 owner=a test=-',
      'suite-end a pass',
      'file-end',
    ])
  })

  test('a hook reports the suite it was declared on and its index among that suite hooks of its kind', async () => {
    const run = await runScript(({ describe, test, beforeEach }) => {
      beforeEach(() => {})
      beforeEach(() => {})
      describe('a', () => {
        beforeEach(() => {})
        test('t', () => {})
      })
    })
    assert.deepEqual(
      eventLog(run).filter((line) => line.startsWith('hook-start')),
      [
        'hook-start beforeEach#0 owner=file test=a > t',
        'hook-start beforeEach#1 owner=file test=a > t',
        'hook-start beforeEach#0 owner=a test=a > t',
      ],
    )
  })

  test('a failed hook ends with its serialized error, and a passing one with null', async () => {
    const run = await runScript(({ test, beforeEach, afterEach }) => {
      beforeEach(() => {
        throw new Error('hook boom')
      })
      afterEach(() => {})
      test('t', () => {})
    })
    const ends = eventsOf(run.events, 'hook-end')
    assert.deepEqual(
      ends.map((end) => [end.kind, end.error?.message ?? null]),
      [
        ['beforeEach', 'hook boom'],
        ['afterEach', null],
      ],
    )
  })

  test('a failing beforeEach skips the body but not the afterEach hooks', async () => {
    const run = await runScript(({ test, beforeEach, afterEach }, step) => {
      beforeEach(() => {
        throw new Error('hook boom')
      })
      afterEach(() => step('afterEach'))
      test('t', () => step('body'))
    })
    assert.deepEqual(run.trace, ['afterEach'])
    assert.equal(run.states.t, 'fail')
  })

  test('a skipped test and a todo emit a start and an end, and no attempt', async () => {
    const run = await runScript(({ test }) => {
      test.skip('skipped', () => {})
      test.todo('todo')
    })
    assert.deepEqual(eventLog(run).slice(2, -1), [
      'test-start skipped',
      'test-end skipped skip',
      'test-start todo',
      'test-end todo todo',
    ])
  })

  test('every suite that starts ends, in nesting order, including skipped and failed ones', async () => {
    const run = await runScript(
      ({ describe, test, beforeAll }) => {
        describe('a', () => {
          describe('b', () => {
            test('t', () => {})
          })
          describe.skip('c', () => {
            test('u', () => {})
          })
        })
        describe('d', () => {
          beforeAll(() => {
            throw new Error('beforeAll failed')
          })
          describe('e', () => {
            test('v', () => {})
          })
        })
      },
      { hooks: { beforeAllError: 'skip-subtree' } },
    )
    const open: string[] = []
    const closed: string[] = []
    for (const event of run.events) {
      if (event.type === 'suite-start') open.push(event.id)
      if (event.type === 'suite-end') {
        assert.equal(open.pop(), event.id, 'a suite ended while another was the innermost open one')
        closed.push(event.id)
      }
    }
    assert.deepEqual(open, [])
    assert.equal(closed.length, 5)
    assert.equal(new Set(closed).size, 5)
  })

  test('file events frame the run: collect start and end first, file end last', async () => {
    const run = await runScript(({ test }) => {
      test('t', () => {})
    })
    const types = run.events.map((event) => event.type)
    assert.equal(types[0], 'file-collect-start')
    assert.equal(types[1], 'file-collect-end')
    assert.equal(types.at(-1), 'file-end')
    assert.equal(types.filter((type) => type === 'file-end').length, 1)
  })
})
