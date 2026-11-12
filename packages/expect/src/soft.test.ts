// expect.soft and expect.unreachable (T7.8): a soft failure is held in the state, the test goes on,
// and the end-of-test check reports it. The engine is the test table's, never a dialect's.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ExpectMessages, ExpectStatic } from '@provino/types'
import { createEndOfTest } from './end-of-test.ts'
import { ExpectError } from './errors.ts'
import { MatcherResultError } from './expect.ts'
import { testEngine, testTable, testTask } from './internal/test-support.ts'

const soft = (expect: ExpectStatic): NonNullable<ExpectStatic['soft']> => {
  assert.ok(expect.soft, 'expect.soft is there')
  return expect.soft
}

describe('expect.soft', () => {
  test('exists only under ExpectPolicy.soft', () => {
    assert.equal(testEngine().expect.soft, undefined)
    assert.equal(typeof testEngine({ policy: { soft: true } }).expect.soft, 'function')
  })

  test('a failure is held back, counted, and the next line runs', () => {
    const { expect, current, source } = testEngine({ policy: { soft: true } })
    current.enter(testTask('t'))
    soft(expect)(1).toBe(2)
    soft(expect)(3).toBe(3)
    const state = source.current()
    assert.equal(state.suppressedErrors.length, 1)
    assert.ok(state.suppressedErrors[0] instanceof MatcherResultError)
    assert.equal(state.suppressedErrors[0]?.message, 'toBe: 1 vs 2')
    assert.equal(state.assertionCalls, 2)
    assert.equal(state.numPassingAsserts, 1)
  })

  test('.not is soft too, and a hard assertion beside it still throws', () => {
    const { expect, current, source } = testEngine({ policy: { soft: true } })
    current.enter(testTask('t'))
    soft(expect)(1).not.toBe(1)
    assert.equal(source.current().suppressedErrors.length, 1)
    assert.throws(() => expect(1).toBe(2), /toBe: 1 vs 2/)
    assert.equal(source.current().suppressedErrors.length, 1)
  })

  test('a soft assertion on a promise holds its failure when the promise settles', async () => {
    const { expect, current, source } = testEngine({ policy: { soft: true } })
    current.enter(testTask('t'))
    await soft(expect)(Promise.resolve(1)).resolves.toBe(2)
    await soft(expect)(Promise.resolve(1)).rejects.toBe(1)
    await soft(expect)(Promise.resolve(2)).resolves.toBe(2)
    const state = source.current()
    assert.equal(state.suppressedErrors.length, 2)
    assert.equal(state.numPassingAsserts, 1)
  })

  test('outside a test it throws EXPECT_OUTSIDE_TEST with the table text', () => {
    const { expect } = testEngine({ policy: { soft: true } })
    assert.throws(
      () => soft(expect)(1),
      (error: unknown) =>
        error instanceof ExpectError &&
        error.code === 'EXPECT_OUTSIDE_TEST' &&
        error.message === 'soft needs a running test',
    )
  })

  test('takes one argument, like expect', () => {
    const { expect, current } = testEngine({ policy: { soft: true } })
    current.enter(testTask('t'))
    assert.throws(() => (soft(expect) as (a: unknown, b: unknown) => unknown)(1, 2), /too many/)
  })

  test('two runs of a test keep their own failures', () => {
    const { expect, current, source } = testEngine({ policy: { soft: true } })
    const task = testTask('t')
    current.enter(task, 0)
    soft(expect)(1).toBe(2)
    current.enter(task, 1)
    soft(expect)(1).toBe(1)
    assert.equal(source.stateOf('t', { attempt: 0, repeat: 0 })?.suppressedErrors.length, 1)
    assert.equal(source.stateOf('t', { attempt: 1, repeat: 0 })?.suppressedErrors.length, 0)
  })

  test('the end-of-test check hands the failures over, in order, once', () => {
    const table = testTable()
    const { expect, current, source } = testEngine({ policy: { soft: true }, table })
    const endOfTest = createEndOfTest({
      source,
      messages: table.messages,
      policy: { requireAssertions: false },
      hasAssertionsWhenFailed: 'skip',
    })
    current.enter(testTask('t'))
    soft(expect)(1).toBe(2)
    soft(expect)('a').toBe('b')
    const run = { test: { id: 't' }, attempt: 0, repeat: 0, failed: false }
    assert.deepEqual(
      endOfTest(run).map((error) => error.message),
      ['toBe: 1 vs 2', 'toBe: a vs b'],
    )
    assert.deepEqual(endOfTest(run), [])
  })
})

describe('expect.unreachable', () => {
  test('is on expect only when the table words it', () => {
    const table = testTable()
    const { unreachable: _, ...messages } = table.messages
    const without: typeof table = { ...table, messages: messages as ExpectMessages }
    assert.equal(testEngine({ table: without }).expect.unreachable, undefined)
    assert.equal(typeof testEngine().expect.unreachable, 'function')
  })

  test('throws the table text, anchored at the caller', () => {
    const { expect } = testEngine()
    const unreachable = expect.unreachable
    assert.ok(unreachable)
    let thrown: unknown
    try {
      unreachable('never here')
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof MatcherResultError)
    assert.equal(thrown.message, 'unreachable: never here')
    assert.match(String(thrown.stack).split('\n')[1] ?? '', /soft\.test\.ts/)
    assert.throws(() => unreachable(), new MatcherResultError('unreachable'))
  })
})
