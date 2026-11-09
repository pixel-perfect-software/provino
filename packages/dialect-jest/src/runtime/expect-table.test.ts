import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import { createBehaviourLoader, isModuleRef } from '@provino/policy'
import { jestExpectPolicy } from '../expect-policy.ts'
import { jestExpectTable } from './expect-table.ts'
import { setUpJestExpect } from './internal/test-support.ts'

/** Jest 30.5's instance matchers (Track 7 F2) without the 4 snapshot ones (T7.10), sorted. */
const JEST_MATCHERS = [
  'toBe',
  'toBeCloseTo',
  'toBeDefined',
  'toBeFalsy',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeInstanceOf',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeNaN',
  'toBeNull',
  'toBeTruthy',
  'toBeUndefined',
  'toContain',
  'toContainEqual',
  'toEqual',
  'toHaveBeenCalled',
  'toHaveBeenCalledTimes',
  'toHaveBeenCalledWith',
  'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith',
  'toHaveLastReturnedWith',
  'toHaveLength',
  'toHaveNthReturnedWith',
  'toHaveProperty',
  'toHaveReturned',
  'toHaveReturnedTimes',
  'toHaveReturnedWith',
  'toMatch',
  'toMatchObject',
  'toStrictEqual',
  'toThrow',
]

/** Removed in Jest 30 (#14632); Vitest keeps them. */
const REMOVED_ALIASES = [
  'toBeCalled',
  'toBeCalledTimes',
  'toBeCalledWith',
  'lastCalledWith',
  'nthCalledWith',
  'toReturn',
  'toReturnTimes',
  'toReturnWith',
  'lastReturnedWith',
  'nthReturnedWith',
  'toThrowError',
]

const SNAPSHOT_MATCHERS = [
  'toMatchInlineSnapshot',
  'toMatchSnapshot',
  'toThrowErrorMatchingInlineSnapshot',
  'toThrowErrorMatchingSnapshot',
]

test('the table has Jest 30.5`s 32 matchers in order of registration, then its 4 snapshot ones', () => {
  const { matchers } = jestExpectTable()
  const names = Object.keys(matchers)
  assert.deepEqual(names.toSorted(), [...JEST_MATCHERS, ...SNAPSHOT_MATCHERS].toSorted())
  assert.equal(names[0], 'toBe')
  assert.equal(names[31], 'toThrow')
  assert.deepEqual(names.slice(32).toSorted(), SNAPSHOT_MATCHERS)
  assert.equal(names.includes('toMatchFileSnapshot'), false, 'that one is Vitest`s')
})

test('no removed alias is registered', () => {
  const { matchers } = jestExpectTable()
  for (const alias of REMOVED_ALIASES) assert.equal(alias in matchers, false, alias)
})

test('toThrow has a promise form; the asymmetric tables match index.ts', () => {
  const table = jestExpectTable()
  assert.deepEqual(Object.keys(table.promiseMatchers), [
    'toThrow',
    'toThrowErrorMatchingSnapshot',
    'toThrowErrorMatchingInlineSnapshot',
  ])
  assert.notEqual(table.promiseMatchers.toThrow, table.matchers.toThrow)
  assert.deepEqual(Object.keys(table.asymmetric).toSorted(), [
    'any',
    'anything',
    'arrayContaining',
    'arrayOf',
    'closeTo',
    'objectContaining',
    'stringContaining',
    'stringMatching',
  ])
  assert.deepEqual(Object.keys(table.asymmetricNot).toSorted(), [
    'arrayContaining',
    'arrayOf',
    'closeTo',
    'objectContaining',
    'stringContaining',
    'stringMatching',
  ])
})

test('the policy`s matcherTable loads jestExpectTable through the behaviour loader', async () => {
  const ref = jestExpectPolicy.matcherTable
  assert.ok(ref !== null && isModuleRef(ref))
  const factory = await createBehaviourLoader().load(ref)
  assert.equal(factory, jestExpectTable)
})

test('the messages are Jest`s', () => {
  const { messages } = jestExpectTable()
  assert.equal(messages.tooManyArguments(), 'Expect takes at most one argument.')
  assert.equal(
    stripVTControlCharacters(
      messages.rejectedInsteadOfResolved(
        { matcherName: 'toBe', isNot: false, promise: 'resolves' },
        1,
      ),
    ),
    'expect(received).resolves.toBe()\n\nReceived promise rejected instead of resolved\nRejected to value: 1',
  )
})

test('extend`s asymmetric forms share one class per registration, as in Jest', (t) => {
  const { expect } = setUpJestExpect(t)
  expect.extend({
    toBeWithin: (received: number, low: number, high: number) => ({
      pass: received >= low && received <= high,
      message: () => '',
    }),
  })
  // `extend` adds the names at runtime, so `expect` reads them as `unknown`.
  type Builder = (low: number, high: number) => object
  const within = expect.toBeWithin as Builder
  const notWithin = expect.not.toBeWithin as Builder
  const a = within(1, 2)
  const b = within(1, 2)
  assert.equal(a.constructor, b.constructor)
  assert.equal(notWithin(1, 2).constructor, a.constructor)
  expect({ x: a }).toStrictEqual({ x: b })
})
