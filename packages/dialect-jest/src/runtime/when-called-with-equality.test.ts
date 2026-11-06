// `@provino/mock`'s `whenCalledWith` can't import @jest/expect-utils, so it has its own equality.
// This checks that it answers what jest-mock's `equals(a, b, [iterableEquality])` answers: a call
// with `b` reaches the branch registered for `a` exactly when `equals` says so. It lives under
// `runtime/` because the package's root node may not import `@provino/mock`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { equals, iterableEquality } from '@jest/expect-utils'
import { jestMockPolicy } from '@provino/dialect-jest'
import { createMockFn, createMockRegistry } from '@provino/mock'

const ANYTHING = {
  asymmetricMatch: (other: unknown) => other !== undefined,
}
const ONLY_NUMBERS = {
  asymmetricMatch: (other: unknown) => typeof other === 'number',
}

function cycle(value: number): object {
  const self: { value: number; self?: object } = { value }
  self.self = self
  return self
}

function cycleInSet(value: number): object {
  const set = new Set<unknown>([value])
  set.add(set)
  return set
}

class Point {
  readonly x: number
  constructor(x: number) {
    this.x = x
  }
}

function* two(): Generator<number> {
  yield 1
  yield 2
}

const SYMBOL = Symbol('key')

const PAIRS: ReadonlyArray<readonly [name: string, a: unknown, b: unknown]> = [
  ['the same primitive', 1, 1],
  ['different primitives', 1, 2],
  ['a string and a number', '1', 1],
  ['null and undefined', null, undefined],
  ['NaN and NaN', Number.NaN, Number.NaN],
  ['+0 and -0', 0, -0],
  ['-0 and -0', -0, -0],
  ['a boxed and a plain number', Object(1), 1],
  ['two boxed numbers', Object(1), Object(1)],
  ['two boxed strings that differ', Object('a'), Object('b')],
  ['arrays', [1, 2], [1, 2]],
  ['arrays of different lengths', [1, 2], [1]],
  ['a trailing undefined in an array', [1, undefined], [1]],
  ['nested arrays', [[1, [2, [3]]]], [[1, [2, [3]]]]],
  ['nested arrays that differ deep down', [[1, [2, [3]]]], [[1, [2, [4]]]]],
  ['an array and an object', [1], { 0: 1 }],
  ['objects', { a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }],
  ['objects that differ', { a: 1 }, { a: 2 }],
  ['an undefined key and no key', { a: undefined, b: 1 }, { b: 1 }],
  ['no key and an undefined key', { b: 1 }, { a: undefined, b: 1 }],
  ['an undefined key and a defined one', { a: undefined }, { a: 1 }],
  ['symbol keys', { [SYMBOL]: 1 }, { [SYMBOL]: 1 }],
  ['symbol keys that differ', { [SYMBOL]: 1 }, { [SYMBOL]: 2 }],
  ['a class instance and a plain object', new Point(1), { x: 1 }],
  ['dates', new Date(5), new Date(5)],
  ['dates that differ', new Date(5), new Date(6)],
  ['invalid dates', new Date(Number.NaN), new Date(Number.NaN)],
  ['a date and a number', new Date(5), 5],
  ['regular expressions', /a/g, /a/g],
  ['regular expressions with other flags', /a/g, /a/i],
  ['regular expressions with another source', /a/, /b/],
  ['URLs', new URL('https://a.test/'), new URL('https://a.test/')],
  ['URLs that differ', new URL('https://a.test/'), new URL('https://b.test/')],
  ['a Set in another order', new Set([1, 2, 3]), new Set([3, 1, 2])],
  ['Sets that differ', new Set([1, 2]), new Set([1, 3])],
  ['Sets of different sizes', new Set([1]), new Set([1, 2])],
  [
    'a Set of objects in another order',
    new Set([{ a: 1 }, { b: 2 }]),
    new Set([{ b: 2 }, { a: 1 }]),
  ],
  [
    'a Map in another order',
    new Map([
      ['a', 1],
      ['b', 2],
    ]),
    new Map([
      ['b', 2],
      ['a', 1],
    ]),
  ],
  ['Maps with another value', new Map([['a', 1]]), new Map([['a', 2]])],
  ['Maps with object keys', new Map([[{ k: 1 }, 'v']]), new Map([[{ k: 1 }, 'v']])],
  [
    'a nested Set in a Map in another order',
    new Map([['a', new Set([1, 2])]]),
    new Map([['a', new Set([2, 1])]]),
  ],
  ['a Set and a Map', new Set(), new Map()],
  ['a Set and an array', new Set([1]), [1]],
  ['generators', two(), two()],
  ['typed arrays', new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  ['typed arrays that differ', new Uint8Array([1, 2]), new Uint8Array([1, 3])],
  ['an asymmetric matcher that matches', ANYTHING, 1],
  ['an asymmetric matcher that does not', ANYTHING, undefined],
  ['an asymmetric matcher nested', { a: ONLY_NUMBERS }, { a: 1 }],
  ['an asymmetric matcher nested that does not match', { a: ONLY_NUMBERS }, { a: 'no' }],
  ['an asymmetric matcher on a key that is missing', { a: ONLY_NUMBERS }, {}],
  ['two asymmetric matchers, the same', ANYTHING, ANYTHING],
  ['two asymmetric matchers, different', ANYTHING, ONLY_NUMBERS],
  ['Errors with the same message', new Error('x'), new Error('x')],
  ['Errors with another message', new Error('x'), new Error('y')],
  ['an Error and a TypeError with the same message', new Error('x'), new TypeError('x')],
  ['an Error and a plain object', new Error('x'), { message: 'x' }],
  ['a cycle against a matching cycle', cycle(1), cycle(1)],
  ['a cycle against a different cycle', cycle(1), cycle(2)],
  ['a cycle against a non-cycle', cycle(1), { value: 1, self: { value: 1 } }],
  ['a cycle in a Set', cycleInSet(1), cycleInSet(1)],
  ['the same function', noop, noop],
  ['different functions', noop, () => {}],
]

function noop(): void {}

/** Whether a call with `b` reaches the branch registered for `a`. */
function routes(a: unknown, b: unknown): boolean {
  const mock = createMockFn(jestMockPolicy, createMockRegistry())
  mock.whenCalledWith(a).mockReturnValue('matched')
  return mock(b) === 'matched'
}

for (const [name, a, b] of PAIRS) {
  test(`whenCalledWith agrees with equals: ${name}`, () => {
    assert.equal(routes(a, b), equals([a], [b], [iterableEquality]))
  })
}

test('the table has both answers, so agreement says something', () => {
  const answers = new Set(PAIRS.map(([, a, b]) => equals([a], [b], [iterableEquality])))
  assert.deepEqual([...answers].sort(), [false, true])
})
