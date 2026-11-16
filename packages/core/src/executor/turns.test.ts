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
})
