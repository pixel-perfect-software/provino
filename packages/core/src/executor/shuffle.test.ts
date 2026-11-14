// T5.13: the shuffle of a randomized run (`core.shuffle`, `RunFileOptions.shuffleSeed`). The order
// rules are jest-circus 30.5's `_runTestsForDescribeBlockOnce` (`run.ts`): a block is shuffled once,
// the first time it runs, after its `beforeAll` hooks and before concurrent tests are regrouped;
// skipped blocks are shuffled too. The generator is the policy's; Jest's own is held to the
// recorded order in `@provino/dialect-jest` and `provino`'s `jest-randomize.test.ts`.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ShuffleFactory, TaskId } from '@provino/types'
import { runScript, type Script } from '../internal/test-support.ts'

/**
 * A factory whose shuffles rotate the array left by one, in place, and record the seed and every
 * array length they were asked to shuffle. Deterministic and easy to read in a trace.
 */
function rotating(): { readonly factory: ShuffleFactory; readonly seen: string[] } {
  const seen: string[] = []
  const factory: ShuffleFactory = (seed) => {
    seen.push(`seed ${seed}`)
    return <T>(items: T[]): T[] => {
      seen.push(`shuffle ${items.length}`)
      const first = items.shift()
      if (first !== undefined) items.push(first)
      return items
    }
  }
  return { factory, seen }
}

describe('shuffle', () => {
  test('without a seed the declared order runs and no shuffle is built', async () => {
    const { factory, seen } = rotating()
    const run = await runScript(
      ({ test }, step) => {
        test('a', () => step('a'))
        test('b', () => step('b'))
      },
      { shuffle: factory },
    )
    assert.deepEqual(run.trace, ['a', 'b'])
    assert.deepEqual(seen, [])
  })

  test('one shuffle is built per file from the seed, and every block is shuffled once, parent first', async () => {
    const { factory, seen } = rotating()
    const run = await runScript(
      ({ describe, test }, step) => {
        test('a', () => step('a'))
        describe('one', () => {
          test('x', () => step('x'))
          test('y', () => step('y'))
          test('z', () => step('z'))
        })
        test('b', () => step('b'))
      },
      { shuffle: factory },
      { shuffleSeed: 1234 },
    )
    // The file: [a, one, b] becomes [one, b, a]; then `one`: [x, y, z] becomes [y, z, x].
    assert.deepEqual(run.trace, ['y', 'z', 'x', 'b', 'a'])
    assert.deepEqual(seen, ['seed 1234', 'shuffle 3', 'shuffle 3'])
  })

  test('a block is shuffled after its beforeAll hooks, and a skipped block is shuffled too', async () => {
    const { factory } = rotating()
    const run = await runScript(
      ({ describe, test, beforeAll }, step) => {
        describe('one', () => {
          beforeAll(() => step('beforeAll'))
          test('x', () => step('x'))
          test('y', () => step('y'))
        })
        describe.skip('two', () => {
          test('p', () => step('p'))
          test('q', () => step('q'))
        })
      },
      { shuffle: factory },
      { shuffleSeed: 1 },
    )
    assert.deepEqual(run.trace, ['beforeAll', 'y', 'x'])
    assert.deepEqual(run.states, {
      'one > y': 'pass',
      'one > x': 'pass',
      'two > q': 'skip',
      'two > p': 'skip',
    })
    const tests = run.events
      .filter((event) => event.type === 'test-start')
      .map((event) => run.paths.get(event.id))
    assert.deepEqual(tests, ['two > q', 'two > p', 'one > y', 'one > x'])
  })

  test('concurrent tests are regrouped after the shuffle', async () => {
    const { factory } = rotating()
    const run = await runScript(
      ({ test }, step) => {
        test('a', () => step('a'))
        test.concurrent('c1', () => step('c1'))
        test.concurrent('c2', () => step('c2'))
        test('b', () => step('b'))
      },
      { shuffle: factory, concurrency: { grouping: 'hoist-to-first', limitHooks: true } },
      { shuffleSeed: 1 },
    )
    // [a, c1, c2, b] becomes [c1, c2, b, a]; the concurrent pair is one group at c1's place.
    assert.deepEqual(run.trace, ['c1', 'c2', 'b', 'a'])
  })

  test('a policy with no shuffle refuses a seed before importing the file', async () => {
    const run = await runScript(
      ({ test }, step) => {
        step('imported')
        test('a', () => step('a'))
      },
      {},
      { shuffleSeed: 1 },
    )
    assert.deepEqual(run.trace, [])
    assert.equal(run.file.state, 'fail')
    assert.match(run.file.errors[0]?.message ?? '', /Invalid shuffleSeed.*no `shuffle`/)
    assert.equal(run.file.errors[0]?.code, 'CORE_INVALID_ARGUMENT')
  })

  test('a seed that is not an integer fails the file', async () => {
    const { factory } = rotating()
    for (const seed of [1.5, Number.NaN, '7' as unknown as number]) {
      const run = await runScript(
        ({ test }) => test('a', () => {}),
        { shuffle: factory },
        { shuffleSeed: seed },
      )
      assert.equal(run.file.state, 'fail', String(seed))
      assert.match(run.file.errors[0]?.message ?? '', /Invalid shuffleSeed.*expected an integer/)
    }
  })

  test('a shuffled suite and the file report the order of their children; an unshuffled run reports none', async () => {
    const { factory } = rotating()
    const body: Script = ({ describe, test }) => {
      test('a', () => {})
      describe('one', () => {
        test('x', () => {})
        test('y', () => {})
      })
    }
    const shuffled = await runScript(body, { shuffle: factory }, { shuffleSeed: 1 })
    const names = (ids: readonly TaskId[] | undefined) => ids?.map((id) => shuffled.paths.get(id))
    assert.deepEqual(names(shuffled.suites.one?.childOrder), ['one > y', 'one > x'])
    assert.deepEqual(names(shuffled.file.childOrder), ['one', 'a'])
    const plain = await runScript(body, { shuffle: factory })
    assert.equal(plain.suites.one?.childOrder, undefined)
    assert.equal(plain.file.childOrder, undefined)
  })
})
