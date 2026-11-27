// The table's asymmetric matchers: each matches, does not match, and inverts under expect.not.
import assert from 'node:assert/strict'
import { describe, test } from 'provino'
import { provinoExpectTable } from './index.ts'

const { asymmetric, asymmetricNot } = provinoExpectTable()
type Factory = (...args: never[]) => {
  asymmetricMatch(other: unknown): boolean
  toString(): string
  toAsymmetricMatcher?(): string
}
const make = (name: string, inverse: boolean, ...args: unknown[]) =>
  ((inverse ? asymmetricNot : asymmetric)[name] as unknown as Factory)(...(args as never[]))

const cases: readonly [name: string, args: unknown[], good: unknown, bad: unknown, text: RegExp][] =
  [
    ['any', [Number], 1, 'a', /^Any$/],
    ['any', [Object], {}, null, /^Any$/],
    ['anything', [], 0, null, /^Anything$/],
    ['objectContaining', [{ a: 1 }], { a: 1, b: 2 }, { a: 2 }, /^ObjectContaining$/],
    ['arrayContaining', [[1]], [1, 2], [2], /^ArrayContaining$/],
    ['stringContaining', ['ell'], 'hello', 'help', /^StringContaining$/],
    ['stringMatching', [/^h/], 'hello', 'jello', /^StringMatching$/],
    ['closeTo', [0.3, 2], 0.1 + 0.2, 0.5, /^NumberCloseTo$/],
  ]

describe('the asymmetric matchers of the table', () => {
  for (const [name, args, good, bad, text] of cases) {
    test(`${name}(${String(args[0])})`, () => {
      assert.equal(make(name, false, ...args).asymmetricMatch(good), true)
      assert.equal(make(name, false, ...args).asymmetricMatch(bad), false)
      assert.equal(make(name, true, ...args).asymmetricMatch(good), false)
      assert.equal(make(name, true, ...args).asymmetricMatch(bad), true)
      assert.match(make(name, false, ...args).toString(), text)
    })
  }

  test('the inverse is described as Jest describes it, and Nothing', () => {
    assert.equal(make('stringContaining', true, 'x').toString(), 'StringNotContaining')
    assert.equal(make('objectContaining', true, {}).toString(), 'ObjectNotContaining')
    assert.equal(make('closeTo', true, 1).toString(), 'NumberNotCloseTo')
    assert.equal(make('anything', true).toString(), 'Nothing')
  })

  test('toAsymmetricMatcher prints as Jest 30.5.2 does (the snapshot printer reads it)', () => {
    assert.equal(make('any', false, Number).toAsymmetricMatcher?.(), 'Any<Number>')
    assert.equal(make('any', false, class Thing {}).toAsymmetricMatcher?.(), 'Any<Thing>')
    assert.equal(make('anything', false).toAsymmetricMatcher?.(), 'Anything')
    assert.equal(
      make('closeTo', false, 0.3, 2).toAsymmetricMatcher?.(),
      'NumberCloseTo 0.3 (two digits)',
    )
    assert.equal(
      make('closeTo', false, 1, 1).toAsymmetricMatcher?.(),
      'NumberCloseTo 1 (one digit)',
    )
    assert.equal(
      make('closeTo', false, 1, 20).toAsymmetricMatcher?.(),
      'NumberCloseTo 1 (20 digits)',
    )
  })

  test('a non-object never matches objectContaining or arrayContaining, and inverts', () => {
    assert.equal(make('objectContaining', false, {}).asymmetricMatch(null), false)
    assert.equal(make('arrayContaining', true, []).asymmetricMatch('x'), true)
  })

  test('the custom form of expect.extend runs the matcher with its sample', () => {
    const build = provinoExpectTable().customAsymmetric('toBeWithin', ((
      received: number,
      floor: number,
    ) => ({
      pass: received >= floor,
      message: () => '',
    })) as never)
    assert.equal(build(false, [2]).asymmetricMatch(3), true)
    assert.equal(build(true, [2]).asymmetricMatch(3), false)
    assert.equal(build(true, [2]).toString(), 'not.toBeWithin')
    assert.equal(build(false, [2, 3]).toAsymmetricMatcher?.(), 'toBeWithin<2, 3>')
  })
})
