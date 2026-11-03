import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import { createBehaviourLoader, isModuleRef } from '@provino/policy'
import { jestExpectPolicy } from '../expect-policy.ts'
import { jestExpectTable } from './expect-table.ts'

/** Jest 30.5's instance matchers (Track 7 F2) without the 4 snapshot ones (T7.10). */
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

test('the table has Jest 30.5`s 32 non-snapshot matchers, in order of registration', () => {
  const { matchers } = jestExpectTable()
  assert.deepEqual(Object.keys(matchers).toSorted(), JEST_MATCHERS)
  assert.equal(Object.keys(matchers)[0], 'toBe')
  assert.equal(Object.keys(matchers).at(-1), 'toThrow')
})

test('no removed alias is registered', () => {
  const { matchers } = jestExpectTable()
  for (const alias of REMOVED_ALIASES) assert.equal(alias in matchers, false, alias)
})

test('toThrow has a promise form; the asymmetric tables match index.ts', () => {
  const table = jestExpectTable()
  assert.deepEqual(Object.keys(table.promiseMatchers), ['toThrow'])
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
