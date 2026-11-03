// How a user function is called: what `firstArg` hands it, the `done` callback, generator tests
// (`allowGeneratorFns`) and what a test may return (`nonPromiseReturn`).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FileTask, SuiteTask, TestContext } from '@provino/types'
import { runScript, type Script, type ScriptRun } from '../internal/test-support.ts'

type Done = (reason?: unknown) => void

/** A function that takes a `done` callback, typed as the test function the API expects. */
const withDone = (fn: (done: Done) => unknown): never => fn as never

/** The message of the first error of a test. */
const firstError = (run: ScriptRun, name: string): string | undefined => run.errors[name]?.[0]

describe('firstArg: context', () => {
  test('a test receives its context', async () => {
    let seen: TestContext | undefined
    await runScript(
      ({ test }) => {
        test('t', (ctx) => {
          seen = ctx
        })
      },
      { firstArg: 'context' },
    )
    assert.equal(seen?.task.name, 't')
    assert.equal(seen?.signal.aborted, false)
  })

  test('a function with one parameter is not mistaken for a done callback', async () => {
    const run = await runScript(
      ({ test }) => {
        test('t', (_ctx) => {})
      },
      { firstArg: 'context' },
    )
    assert.equal(run.states.t, 'pass')
  })

  test('an each-hook receives the context, then the test innermost suite', async () => {
    const seen: Array<[string, string, string]> = []
    await runScript(
      ({ describe, test, beforeEach, afterEach }) => {
        beforeEach((ctx, suite) => {
          seen.push(['file beforeEach', ctx.task.name, suite.name])
        })
        describe('a', () => {
          afterEach((ctx, suite) => {
            seen.push(['a afterEach', ctx.task.name, suite.name])
          })
          describe('b', () => {
            test('t', () => {})
          })
        })
      },
      { firstArg: 'context' },
    )
    assert.deepEqual(seen, [
      ['file beforeEach', 't', 'b'],
      ['a afterEach', 't', 'b'],
    ])
  })

  test('a suite hook receives the suite it is declared on, and the file for a file hook', async () => {
    const seen: Array<[string, string, string]> = []
    await runScript(
      ({ describe, test, beforeAll, afterAll }) => {
        beforeAll((suite: SuiteTask | FileTask) => {
          seen.push(['file beforeAll', suite.type, suite.name])
        })
        describe('a', () => {
          afterAll((suite: SuiteTask | FileTask) => {
            seen.push(['a afterAll', suite.type, suite.name])
          })
          test('t', () => {})
        })
      },
      { firstArg: 'context' },
    )
    assert.deepEqual(seen, [
      ['file beforeAll', 'file', 'script.test.ts'],
      ['a afterAll', 'suite', 'a'],
    ])
  })

  test('a test body has no `this`', async () => {
    let seen: unknown = 'unset'
    await runScript(
      ({ test }) => {
        test('t', function (this: unknown) {
          seen = this
        })
      },
      { firstArg: 'context' },
    )
    assert.equal(seen, undefined)
  })

  test('no hook has a `this` either', async () => {
    const selves: unknown[] = []
    await runScript(
      ({ test, beforeAll, beforeEach, afterEach, afterAll }) => {
        for (const hook of [beforeAll, beforeEach, afterEach, afterAll]) {
          hook(function (this: unknown) {
            selves.push(this)
          })
        }
        test('t', () => {})
      },
      { firstArg: 'context' },
    )
    assert.deepEqual(selves, [undefined, undefined, undefined, undefined])
  })
})

describe('firstArg: done-if-arity', () => {
  const policy = { firstArg: 'done-if-arity' } as const

  test('done() passes the test, however late it is called', async () => {
    const run = await runScript(({ test }, step) => {
      test(
        't',
        withDone((done) => {
          queueMicrotask(() => {
            step('done called')
            done()
          })
        }),
      )
    }, policy)
    assert.equal(run.states.t, 'pass')
    assert.deepEqual(run.trace, ['done called'])
  })

  test('done(null) passes too', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone((done) => done(null)),
      )
    }, policy)
    assert.equal(run.states.t, 'pass')
  })

  test('done(error) fails the test with that error', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone((done) => done(new Error('from done'))),
      )
    }, policy)
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.errors.t, ['from done'])
  })

  test('done with another value fails the test, naming the value', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone((done) => done('the reason')),
      )
    }, policy)
    assert.equal(run.states.t, 'fail')
    assert.match(firstError(run, 't') ?? '', /the reason/)
  })

  test('a throw before done is called fails the test with the thrown error', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone(() => {
          throw new Error('threw first')
        }),
      )
    }, policy)
    assert.deepEqual(run.errors.t, ['threw first'])
  })

  test('a function that takes done and returns a promise fails with CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone(async (done) => {
          await Promise.resolve()
          done()
        }),
      )
    }, policy)
    assert.equal(run.states.t, 'fail')
    assert.equal(run.results.t?.errors[0]?.code, 'CORE_INVALID_ARGUMENT')
  })

  test('an async function that takes done and throws fails with CORE_INVALID_ARGUMENT, its error the cause', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone(async (_done) => {
          throw new Error('async boom')
        }),
      )
    }, policy)
    assert.equal(run.results.t?.errors[0]?.code, 'CORE_INVALID_ARGUMENT')
    assert.equal(run.results.t?.errors[0]?.cause?.message, 'async boom')
  })

  test('a function that calls done and also returns a promise fails with CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone(async (done) => {
          done()
        }),
      )
    }, policy)
    assert.equal(run.results.t?.errors[0]?.code, 'CORE_INVALID_ARGUMENT')
  })

  test('beforeEach, the body and afterEach share one `this` per attempt, with no prototype', async () => {
    const seen: Array<[string, unknown]> = []
    await runScript(({ test, beforeEach, afterEach }) => {
      beforeEach(function (this: { value?: string }) {
        this.value = 'set in beforeEach'
        seen.push(['beforeEach', this])
      })
      test('t', function (this: { value?: string }) {
        seen.push(['body', this.value])
      })
      afterEach(function (this: unknown) {
        seen.push(['afterEach', this])
      })
    }, policy)
    const shared = seen[0]?.[1]
    assert.equal(Object.getPrototypeOf(shared), null)
    assert.deepEqual(seen, [
      ['beforeEach', shared],
      ['body', 'set in beforeEach'],
      ['afterEach', shared],
    ])
  })

  test('each attempt and each test get a `this` of their own', async () => {
    const selves: unknown[] = []
    await runScript(({ test, beforeEach }) => {
      beforeEach(function (this: unknown) {
        selves.push(this)
      })
      let calls = 0
      test('retried', { retry: 1 }, () => {
        if (++calls === 1) throw new Error('first attempt fails')
      })
      test('other', () => {})
    }, policy)
    assert.equal(new Set(selves).size, 3)
  })

  test('beforeAll and afterAll each get a fresh `this`, apart from the tests', async () => {
    const selves: unknown[] = []
    await runScript(({ test, beforeAll, afterAll, beforeEach }) => {
      for (const hook of [beforeAll, afterAll, beforeEach]) {
        hook(function (this: unknown) {
          selves.push(this)
        })
      }
      test('t', () => {})
    }, policy)
    assert.equal(selves.length, 3)
    assert.equal(new Set(selves).size, 3)
    for (const self of selves) assert.equal(typeof self, 'object')
  })

  test('a function that takes no parameter is called with no arguments, and a shared `this`', async () => {
    let args: unknown[] = []
    let self: unknown
    await runScript(({ test }) => {
      test('t', function (this: unknown, ...rest: unknown[]) {
        args = rest
        self = this
      })
    }, policy)
    assert.deepEqual(args, [])
    assert.equal(typeof self, 'object')
    assert.notEqual(self, null)
  })

  test('a hook can take done as well', async () => {
    const run = await runScript(({ test, beforeEach }, step) => {
      beforeEach(
        withDone((done) => {
          step('hook')
          done()
        }),
      )
      test('t', () => step('body'))
    }, policy)
    assert.deepEqual(run.trace, ['hook', 'body'])
  })

  test('a .each row passes the row first, and done after it', async () => {
    const seen: unknown[] = []
    const run = await runScript(({ test }) => {
      test.each([[1], [2]])('row %i', ((row: number, done: Done) => {
        seen.push(row)
        done()
      }) as never)
    }, policy)
    assert.deepEqual(seen, [1, 2])
    assert.deepEqual(run.states, { 'row 1': 'pass', 'row 2': 'pass' })
  })
})

describe('allowGeneratorFns and nonPromiseReturn', () => {
  const generator: Script = ({ test }, step) => {
    test('g', function* () {
      const value: unknown = yield Promise.resolve(2)
      step(`got ${value}`)
    })
  }

  for (const nonPromiseReturn of ['fail', 'ignore'] as const) {
    test(`allowGeneratorFns true runs a generator test, awaiting what it yields (nonPromiseReturn ${nonPromiseReturn})`, async () => {
      const run = await runScript(generator, { allowGeneratorFns: true, nonPromiseReturn })
      assert.equal(run.states.g, 'pass')
      assert.deepEqual(run.trace, ['got 2'])
    })
  }

  test('allowGeneratorFns false with nonPromiseReturn fail fails the test, and the body never runs', async () => {
    const run = await runScript(generator, { allowGeneratorFns: false, nonPromiseReturn: 'fail' })
    assert.equal(run.states.g, 'fail')
    assert.equal(run.results.g?.errors[0]?.code, 'CORE_NON_PROMISE_RETURN')
    assert.deepEqual(run.trace, [])
  })

  test('allowGeneratorFns false with nonPromiseReturn ignore passes the test without running the body', async () => {
    const run = await runScript(generator, { allowGeneratorFns: false, nonPromiseReturn: 'ignore' })
    assert.equal(run.states.g, 'pass')
    assert.deepEqual(run.trace, [])
  })

  test('a generator test throws into the generator when a yielded promise rejects', async () => {
    const run = await runScript(
      ({ test }, step) => {
        test('g', function* () {
          try {
            yield Promise.reject(new Error('rejected'))
          } catch (error) {
            step(`caught ${(error as Error).message}`)
          }
        })
      },
      { allowGeneratorFns: true },
    )
    assert.deepEqual(run.trace, ['caught rejected'])
    assert.equal(run.states.g, 'pass')
  })

  test('a generator test fails when the generator throws', async () => {
    const run = await runScript(
      ({ test }) => {
        test('g', function* () {
          yield 1
          throw new Error('generator threw')
        })
      },
      { allowGeneratorFns: true },
    )
    assert.deepEqual(run.errors.g, ['generator threw'])
  })

  test('an async generator test is driven to the end', async () => {
    const run = await runScript(
      ({ test }, step) => {
        test('g', async function* () {
          await Promise.resolve()
          yield 1
          step('finished')
        })
      },
      { allowGeneratorFns: true },
    )
    assert.deepEqual(run.trace, ['finished'])
    assert.equal(run.states.g, 'pass')
  })
})

describe('nonPromiseReturn', () => {
  const returns =
    (value: unknown): Script =>
    ({ test }) => {
      test('t', () => value)
    }

  for (const [what, value] of [
    ['a number', 1],
    ['a string', 'text'],
    ['null', null],
    ['an object', { a: 1 }],
  ] as const) {
    test(`fail fails a test that returns ${what}, with CORE_NON_PROMISE_RETURN`, async () => {
      const run = await runScript(returns(value), { nonPromiseReturn: 'fail' })
      assert.equal(run.states.t, 'fail')
      assert.equal(run.results.t?.errors[0]?.code, 'CORE_NON_PROMISE_RETURN')
    })

    test(`ignore passes a test that returns ${what}`, async () => {
      const run = await runScript(returns(value), { nonPromiseReturn: 'ignore' })
      assert.equal(run.states.t, 'pass')
    })
  }

  for (const [what, value] of [
    ['undefined', undefined],
    ['a promise', Promise.resolve()],
    // biome-ignore lint/suspicious/noThenProperty: the point is a thenable that is not a Promise
    ['a thenable', { then: (resolve: () => void) => resolve() }],
  ] as const) {
    test(`fail lets a test return ${what}`, async () => {
      const run = await runScript(returns(value), { nonPromiseReturn: 'fail' })
      assert.equal(run.states.t, 'pass')
    })
  }

  test('fail does not apply to hooks', async () => {
    const run = await runScript(
      ({ test, beforeEach }) => {
        beforeEach(() => 42)
        test('t', () => {})
      },
      { nonPromiseReturn: 'fail' },
    )
    assert.equal(run.states.t, 'pass')
  })
})
