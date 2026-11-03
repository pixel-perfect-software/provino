// T5.6 acceptance, part 3: concurrent tests. Overlap is observed with counters and microtask
// turns (`settle`), never timers: a body that starts, yields, then ends shows which others
// started in between.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runScript, type Script, settle } from '../internal/test-support.ts'

/** A body that records its start and end, with a yield in between. */
const traced = (step: (name: string) => void, name: string) => async (): Promise<void> => {
  step(`${name} start`)
  await settle()
  step(`${name} end`)
}

/** A counter of how many calls are in flight, and the most there ever were. */
function gauge(): { enter: () => void; leave: () => void; readonly peak: number } {
  let active = 0
  let peak = 0
  return {
    enter: () => {
      active++
      peak = Math.max(peak, active)
    },
    leave: () => {
      active--
    },
    get peak() {
      return peak
    },
  }
}

describe('concurrency.grouping', () => {
  const script: Script = ({ test }, step) => {
    test('s1', () => step('s1'))
    test.concurrent('c1', traced(step, 'c1'))
    test('s2', () => step('s2'))
    test.concurrent('c2', traced(step, 'c2'))
  }

  test('hoist-to-first runs all of a suite concurrent tests as one group, at the first one', async () => {
    const run = await runScript(script, { concurrency: { grouping: 'hoist-to-first' } })
    assert.deepEqual(run.trace, ['s1', 'c1 start', 'c2 start', 'c1 end', 'c2 end', 's2'])
  })

  test('consecutive groups only neighbouring concurrent tests', async () => {
    const run = await runScript(script, { concurrency: { grouping: 'consecutive' } })
    assert.deepEqual(run.trace, ['s1', 'c1 start', 'c1 end', 's2', 'c2 start', 'c2 end'])
  })

  test('consecutive runs neighbouring concurrent tests together', async () => {
    const run = await runScript(
      ({ test }, step) => {
        test.concurrent('c1', traced(step, 'c1'))
        test.concurrent('c2', traced(step, 'c2'))
        test('s', () => step('s'))
      },
      { concurrency: { grouping: 'consecutive' } },
    )
    assert.deepEqual(run.trace, ['c1 start', 'c2 start', 'c1 end', 'c2 end', 's'])
  })

  const suites: Script = ({ describe, test }, step) => {
    describe.concurrent('x', () => {
      test('t', traced(step, 'x'))
    })
    describe.concurrent('y', () => {
      test('t', traced(step, 'y'))
    })
  }

  test('consecutive also groups neighbouring concurrent describes', async () => {
    const run = await runScript(suites, { concurrency: { grouping: 'consecutive' } })
    assert.deepEqual(run.trace, ['x start', 'y start', 'x end', 'y end'])
  })

  test('hoist-to-first runs describes one after another, concurrent or not', async () => {
    const run = await runScript(suites, { concurrency: { grouping: 'hoist-to-first' } })
    assert.deepEqual(run.trace, ['x start', 'x end', 'y start', 'y end'])
  })
})

describe('maxConcurrency', () => {
  for (const max of [1, 2, 3]) {
    test(`${max} keeps at most ${max} concurrent tests in flight, and reaches it`, async () => {
      const inFlight = gauge()
      const run = await runScript(
        ({ test }) => {
          for (let n = 0; n < 6; n++) {
            test.concurrent(`t${n}`, async () => {
              inFlight.enter()
              await settle()
              inFlight.leave()
            })
          }
        },
        { maxConcurrency: max },
      )
      assert.equal(run.file.state, 'pass')
      assert.equal(inFlight.peak, max)
    })
  }

  test('a limit above the number of tests lets them all start together', async () => {
    const inFlight = gauge()
    await runScript(
      ({ test }) => {
        for (let n = 0; n < 4; n++) {
          test.concurrent(`t${n}`, async () => {
            inFlight.enter()
            await settle()
            inFlight.leave()
          })
        }
      },
      { maxConcurrency: 10 },
    )
    assert.equal(inFlight.peak, 4)
  })
})

describe('concurrency.limitHooks', () => {
  /** One test with four beforeEach hooks, which `hookOrder` can run at once. */
  const hooks =
    (inFlight: ReturnType<typeof gauge>): Script =>
    ({ test, beforeEach }) => {
      for (let n = 0; n < 4; n++) {
        beforeEach(async () => {
          inFlight.enter()
          await settle()
          inFlight.leave()
        })
      }
      test('t', () => {})
    }

  test('true holds parallel hooks to maxConcurrency', async () => {
    const inFlight = gauge()
    await runScript(hooks(inFlight), {
      maxConcurrency: 2,
      hookOrder: { beforeEach: 'parallel' },
      concurrency: { limitHooks: true },
    })
    assert.equal(inFlight.peak, 2)
  })

  test('false lets every parallel hook run at once', async () => {
    const inFlight = gauge()
    await runScript(hooks(inFlight), {
      maxConcurrency: 2,
      hookOrder: { beforeEach: 'parallel' },
      concurrency: { limitHooks: false },
    })
    assert.equal(inFlight.peak, 4)
  })

  /** Two concurrent describes of three concurrent tests each. */
  const nested =
    (inFlight: ReturnType<typeof gauge>): Script =>
    ({ describe, test }) => {
      for (const suite of ['x', 'y']) {
        describe(suite, { concurrent: true }, () => {
          for (let n = 0; n < 3; n++) {
            test(`t${n}`, async () => {
              inFlight.enter()
              await settle()
              inFlight.leave()
            })
          }
        })
      }
    }

  test('true shares one maxConcurrency limit between tests of different groups', async () => {
    const inFlight = gauge()
    await runScript(nested(inFlight), {
      maxConcurrency: 2,
      concurrency: { grouping: 'consecutive', limitHooks: true },
    })
    assert.equal(inFlight.peak, 2)
  })

  test('false limits each group on its own', async () => {
    const inFlight = gauge()
    await runScript(nested(inFlight), {
      maxConcurrency: 2,
      concurrency: { grouping: 'consecutive', limitHooks: false },
    })
    assert.equal(inFlight.peak, 4)
  })
})
