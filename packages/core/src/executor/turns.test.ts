// `boundaryTurns` (B23e): the microtask turns a promise chain a function leaves running gets before
// the next function starts. `mark` starts a chain of promise hops as a function ends; `seen`, as
// the next one starts, records how many hops it made. Jest's own counts are the runtime corpus's
// `microtask-turns` (harness); these use other values, to show the counts are the policy's sums.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type CoreOverrides, runScript, type Script } from '../internal/test-support.ts'

/** A chain of promise hops started at a function's end, read at the next function's start. */
function probe(step: (name: string) => void): {
  mark(label: string): void
  seen(label: string): void
} {
  let generation = 0
  let hops = 0
  let from: string | undefined
  return {
    mark(label) {
      generation += 1
      const mine = generation
      from = label
      hops = 0
      const hop = (): void => {
        if (generation !== mine) return
        hops += 1
        if (hops < 1000) Promise.resolve().then(hop)
      }
      Promise.resolve().then(hop)
    },
    seen(label) {
      if (from !== undefined) step(`${from} -> ${label}: ${hops}`)
      generation += 1
      from = undefined
    },
  }
}

const TURNS: CoreOverrides = {
  boundaryTurns: { hookStart: 3, hookEnd: 5, fnStart: 4, fnEnd: 6, testStart: 10, testEnd: 8 },
}

const withHooks: Script = ({ test, beforeEach, afterEach }, step) => {
  const { mark, seen } = probe(step)
  let ran = 0
  beforeEach(() => {
    seen('beforeEach')
    mark('beforeEach')
  })
  afterEach(() => {
    seen('afterEach 1')
    mark('afterEach 1')
  })
  afterEach(() => {
    seen('afterEach 2')
    ran += 1
    if (ran < 2) mark('afterEach 2')
  })
  test('sync', () => {
    seen('sync')
    mark('sync')
  })
  test('async', async () => {
    seen('async')
    await null
    mark('async')
  })
}

describe('boundaryTurns', () => {
  test('each count is the sum of the boundaries passed, for sync and async functions', async () => {
    const run = await runScript(withHooks, TURNS)
    // The neutral policy runs a level's `afterEach` hooks last first: `afterEach 2` comes first.
    assert.deepEqual(run.trace, [
      // hookEnd + fnStart
      'beforeEach -> sync: 9',
      // fnEnd + hookStart
      'sync -> afterEach 2: 9',
      // hookEnd + hookStart
      'afterEach 2 -> afterEach 1: 8',
      // hookEnd + testEnd + testStart + hookStart
      'afterEach 1 -> beforeEach: 26',
      'beforeEach -> async: 9',
      // a function that returned a promise is seen on the turn after it settled: one more
      'async -> afterEach 2: 10',
    ])
    assert.equal(run.states.sync, 'pass')
    assert.equal(run.states.async, 'pass')
  })

  test('between tests with no hooks: fnEnd + testEnd + testStart + fnStart', async () => {
    const run = await runScript(({ test }, step) => {
      const { mark, seen } = probe(step)
      test('a', () => {
        seen('a')
        mark('a')
      })
      test('b', () => {
        seen('b')
        mark('b')
        throw new Error('a failure counts as an end too')
      })
      test('c', () => {
        seen('c')
      })
    }, TURNS)
    assert.deepEqual(run.trace, ['a -> b: 28', 'b -> c: 28'])
    assert.equal(run.states.b, 'fail')
  })

  test('all 0 counts nothing: each function starts as soon as core gets to it', async () => {
    const count = (line: string): number => Number(line.slice(line.lastIndexOf(' ') + 1))
    const zero = await runScript(withHooks)
    const paced = await runScript(withHooks, TURNS)
    assert.equal(zero.trace.length, paced.trace.length)
    for (const [index, line] of zero.trace.entries()) {
      const counted = paced.trace[index] ?? ''
      assert.equal(line.slice(0, line.lastIndexOf(':')), counted.slice(0, counted.lastIndexOf(':')))
      // Core's own code alone is fewer turns than any count the policy asks for here.
      assert.ok(count(line) < count(counted), `${line}, against ${counted}`)
    }
  })

  test('hooks that run at once count nothing, and none is left waiting', async () => {
    const run = await runScript(
      ({ test, beforeEach }, step) => {
        const { mark, seen } = probe(step)
        beforeEach(async () => {
          await null
        })
        beforeEach(async () => {
          await null
        })
        test('a', () => {
          seen('a')
          mark('a')
        })
        test('b', () => {
          seen('b')
        })
      },
      {
        ...TURNS,
        hookOrder: {
          beforeAll: 'parallel',
          beforeEach: 'parallel',
          afterEach: 'parallel',
          afterAll: 'parallel',
        },
      },
    )
    assert.equal(run.states.a, 'pass')
    assert.equal(run.states.b, 'pass')
    assert.equal(run.trace.length, 1)
  })

  test('a concurrent group counts nothing, and the boundaries after it count again', async () => {
    const run = await runScript(({ test, afterEach }, step) => {
      const { mark, seen } = probe(step)
      afterEach(() => {
        seen('afterEach')
      })
      test.concurrent('one', async () => {
        await null
      })
      test.concurrent('two', async () => {
        await null
      })
      test('after the group', () => {
        seen('after the group')
        mark('after the group')
      })
    }, TURNS)
    assert.deepEqual(run.trace, ['after the group -> afterEach: 9'])
    assert.equal(run.states['after the group'], 'pass')
  })

  test('a skipped or todo test, and a suite start and end, pay their own turns', async () => {
    const run = await runScript(
      ({ test, describe }, step) => {
        const { mark, seen } = probe(step)
        test('a', () => {
          seen('a')
          mark('a')
        })
        test.skip('skipped', () => {})
        test.todo('todo')
        test('b', () => {
          seen('b')
          mark('b')
        })
        describe('suite', () => {
          test('in', () => {
            seen('in')
            mark('in')
          })
        })
        test('after', () => {
          seen('after')
        })
      },
      { boundaryTurns: { skippedTest: 40, suiteStart: 30, suiteEnd: 35 } },
    )
    // Two passed over, 40 each; a suite's start (30) before its first test, and its end (35) after.
    // The values are above what core's own code takes between functions (about 5 a skipped test).
    assert.deepEqual(run.trace, ['a -> b: 80', 'b -> in: 30', 'in -> after: 35'])
  })

  test('a retry pays its own turns, and an attempt in the retry loop ends with retryEnd', async () => {
    const run = await runScript(
      ({ test, describe }, step) => {
        const { mark, seen } = probe(step)
        describe('block', () => {
          let attempts = 0
          test('flaky', { retry: 2 }, () => {
            attempts += 1
            seen(`flaky ${attempts}`)
            mark(`flaky ${attempts}`)
            if (attempts < 3) throw new Error('expected')
          })
          test('sibling', () => {
            seen('sibling')
            mark('sibling')
          })
        })
        test('last', () => {
          seen('last')
        })
      },
      {
        retry: { timing: 'deferred' },
        boundaryTurns: { testEnd: 30, retry: 20, retryEnd: 25, retryExit: 12 },
      },
    )
    assert.deepEqual(run.trace, [
      // testEnd
      'flaky 1 -> sibling: 30',
      // testEnd + retry: the retry runs after the block's other tests
      'sibling -> flaky 2: 50',
      // retryEnd + retry
      'flaky 2 -> flaky 3: 45',
      // retryEnd + retryExit: the loop ends with the last attempt
      'flaky 3 -> last: 37',
    ])
  })

  test('a done callback ends where it is called: sync, and from a later turn', async () => {
    const run = await runScript(
      ({ test, beforeEach }, step) => {
        const { mark, seen } = probe(step)
        let ran = 0
        beforeEach(((done: () => void) => {
          ran += 1
          seen(`beforeEach ${ran}`)
          if (ran === 1) {
            mark('beforeEach 1')
            done()
          } else {
            void Promise.resolve().then(() => {
              mark('beforeEach 2')
              done()
            })
          }
        }) as never)
        test('one', () => {
          seen('one')
        })
        test('two', () => {
          seen('two')
        })
      },
      { firstArg: 'done-if-arity', boundaryTurns: { hookEnd: 20, fnStart: 20 } },
    )
    // hookEnd + fnStart and the one turn a function that settles a promise takes (as an async
    // hook's), the same for a `done` called inside the hook and for one called later: the promise
    // is settled on the call, not a turn after it (that was 2).
    assert.deepEqual(run.trace, ['beforeEach 1 -> one: 41', 'beforeEach 2 -> two: 41'])
  })

  test('a run start pays its turns to the first function a chain from the module reaches', async () => {
    const first = async (runStart: number): Promise<number> => {
      const run = await runScript(
        ({ test, beforeAll }, step) => {
          const { mark, seen } = probe(step)
          mark('module')
          beforeAll(() => seen('beforeAll'))
          test('t', () => {})
        },
        { boundaryTurns: { runStart } },
      )
      return Number(run.trace[0]?.slice(run.trace[0].lastIndexOf(' ') + 1))
    }
    // Core's own turns come first, from where the import settles: the count is at least the total.
    assert.ok((await first(40)) >= 40)
    assert.ok((await first(0)) < 40)
  })
})
