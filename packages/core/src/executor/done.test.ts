// T5.7: the first-argument rule and Jest's `done`, with its words (jest-circus 30.5 `utils.ts`
// `callAsyncCircusFn`), and the callable context under `firstArg: 'context'`. Against the real
// runners: `@provino/harness`'s runtime corpus (`done-*`, `context-shape`).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { eventsOf, runScript } from '../internal/test-support.ts'

type Done = (reason?: unknown) => void
const withDone = (fn: (done: Done) => unknown): never => fn as never
const jest = {
  firstArg: 'done-if-arity',
  errors: { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' },
} as const

describe('arity', () => {
  test('fn.length is read once, when the function is registered', async () => {
    const run = await runScript(({ test }, step) => {
      const fn = withDone((done) => {
        step('called')
        done()
      })
      test('t', fn)
      // A wrapper that changes `length` later changes nothing.
      Object.defineProperty(fn, 'length', { value: 0 })
    }, jest)
    assert.equal(run.states.t, 'pass')
    assert.deepEqual(run.trace, ['called'])
  })

  test('a default or rest parameter does not count', async () => {
    const run = await runScript(({ test }, step) => {
      test('default', ((a = 1) => step(`default ${typeof a}`)) as never)
      test('rest', ((...args: unknown[]) => step(`rest ${args.length}`)) as never)
    }, jest)
    assert.deepEqual(run.trace, ['default number', 'rest 0'])
    assert.deepEqual(run.states, { default: 'pass', rest: 'pass' })
  })

  test('a .each row takes done only past the row (fn.length > row.length)', async () => {
    const run = await runScript(({ test }, step) => {
      test.each([[1, 2]])('with done', ((_a: number, _b: number, done?: Done) => {
        step(`with done ${typeof done}`)
        done?.()
      }) as never)
      test.each([[1, 2]])('without', ((_a: number, _b: number) => {
        step('without')
      }) as never)
    }, jest)
    assert.deepEqual(run.trace, ['with done function', 'without'])
  })

  test('a generator that declares a parameter takes done, and is not run', async () => {
    const run = await runScript(({ test }, step) => {
      test(
        'g',
        function* (_done: unknown) {
          step('ran')
          yield Promise.resolve()
        } as never,
        40,
      )
    }, jest)
    assert.equal(run.states.g, 'fail')
    assert.deepEqual(run.trace, [])
  })

  test('a hook that declares a parameter takes done', async () => {
    const run = await runScript(({ test, beforeEach }, step) => {
      beforeEach(
        withDone((done) => {
          setTimeout(() => {
            step('hook done')
            done()
          }, 5)
        }),
      )
      test('t', () => step('body'))
    }, jest)
    assert.deepEqual(run.trace, ['hook done', 'body'])
  })
})

describe("Jest's done errors", () => {
  test('a second done() throws to the caller and fails the test', async () => {
    const caught: string[] = []
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone((done) => {
          done()
          try {
            done()
          } catch (error) {
            caught.push((error as Error).message)
          }
        }),
      )
    }, jest)
    const message = 'Expected done to be called once, but it was called multiple times.'
    assert.deepEqual(caught, [message])
    assert.equal(run.states.t, 'fail')
    assert.deepEqual(run.errors.t, [message])
  })

  test('a second done(reason) adds the formatted reason', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone((done) => {
          done()
          try {
            done('why')
          } catch {}
        }),
      )
    }, jest)
    assert.equal(
      run.errors.t?.[0],
      "Expected done to be called once, but it was called multiple times. Reason: 'why'",
    )
  })

  test('done and a returned value fails, naming the value', async () => {
    const run = await runScript(({ test }) => {
      test(
        't',
        withDone((done) => {
          done()
          return 42
        }),
      )
    }, jest)
    assert.equal(
      run.errors.t?.[0],
      "Test functions cannot both take a 'done' callback and return something. Either use a 'done' callback, or return a promise.\nReturned value: 42",
    )
  })

  test('done(reason) fails with `Failed: <reason>`; done(error) fails with the error', async () => {
    const run = await runScript(({ test }) => {
      test(
        'string',
        withDone((done) => done('nope')),
      )
      test(
        'error',
        withDone((done) => done(new Error('boom'))),
      )
      test(
        'falsy',
        withDone((done) => done(0)),
      )
    }, jest)
    assert.deepEqual(run.errors.string, ["Failed: 'nope'"])
    assert.deepEqual(run.errors.error, ['boom'])
    assert.equal(run.states.falsy, 'pass')
  })

  test('the reason is printed with the policy`s formatValue', async () => {
    const run = await runScript(({ test }) => {
      test(
        'object',
        withDone((done) => done({ code: 7 })),
      )
    }, jest)
    assert.equal(run.errors.object?.[0], 'Failed: { code: 7 }')
  })

  test('a function that returns a non-promise value fails with the value (nonPromiseReturn)', async () => {
    const run = await runScript(
      ({ test }) => {
        test('t', (() => 5) as never)
      },
      { nonPromiseReturn: 'fail' },
    )
    assert.equal(
      run.errors.t?.[0],
      'test functions can only return Promise or undefined.\nReturned value: 5',
    )
  })
})

describe('a done that comes after the end', () => {
  test('done() with no reason does nothing; a reason is a late-done error charged to the caller', async () => {
    let late: Done | undefined
    const run = await runScript(({ test }) => {
      test(
        'first',
        withDone((done) => {
          late = done
          done()
        }),
      )
      test('second', async () => {
        late?.()
        await Promise.resolve()
        late?.(new Error('late reason'))
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
    }, jest)
    assert.equal(run.states.first, 'pass')
    const events = eventsOf(run.events, 'unhandled-error')
    assert.equal(events.length, 0, 'fail-owner puts the error on the running test instead')
    assert.equal(run.states.second, 'fail')
    assert.match(
      run.errors.second?.[0] ?? '',
      /^Caught error after test environment was torn down\n\nlate reason$/,
    )
  })

  test('under report-run it is an error of the run, origin late-done', async () => {
    let late: Done | undefined
    const run = await runScript(
      ({ test }) => {
        test(
          'first',
          withDone((done) => {
            late = done
            done()
          }),
        )
        test('second', async () => {
          late?.(new Error('late reason'))
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
      },
      { ...jest, errors: { lateErrors: 'report-run', hasAssertionsWhenFailed: 'skip' } },
    )
    const [event] = eventsOf(run.events, 'unhandled-error')
    assert.equal(event?.origin, 'late-done')
    assert.equal(event?.ownerId, null)
    assert.match(event?.error.message ?? '', /^Caught error after test environment was torn down/)
    assert.equal(run.states.second, 'pass')
  })
})

describe('firstArg: context', () => {
  const vitest = {
    firstArg: 'context',
    doneDeprecatedMessage: 'done() callback is deprecated',
  } as const

  test('the context is a function that throws the policy`s message', async () => {
    const seen: string[] = []
    await runScript(({ test }) => {
      test('t', ((ctx: () => void) => {
        seen.push(typeof ctx)
        try {
          ctx()
        } catch (error) {
          seen.push((error as Error).message)
        }
      }) as never)
    }, vitest)
    assert.deepEqual(seen, ['function', 'done() callback is deprecated'])
  })

  test('with no message the context is a plain object', async () => {
    const seen: string[] = []
    await runScript(
      ({ test }) => {
        test('t', ((ctx: unknown) => {
          seen.push(typeof ctx)
        }) as never)
      },
      { firstArg: 'context', doneDeprecatedMessage: null },
    )
    assert.deepEqual(seen, ['object'])
  })

  test('the context keys are its own: task, signal, skip, annotate and the two callbacks', async () => {
    let keys: string[] = []
    await runScript(({ test }) => {
      test('t', ((ctx: object) => {
        keys = Object.keys(ctx).sort()
      }) as never)
    }, vitest)
    assert.deepEqual(keys, ['annotate', 'onTestFailed', 'onTestFinished', 'signal', 'skip', 'task'])
  })
})
