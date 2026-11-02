import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { environmentConditions, formatEachTitle, snapshotKey } from './behaviours.ts'

describe('formatEachTitle', () => {
  const cases: readonly [
    string,
    readonly unknown[] | Readonly<Record<string, unknown>>,
    number,
    string,
  ][] = [
    ['adds %d + %d', [1, 2], 0, 'adds 1 + 2'],
    ['%s is %s', ['a', 'b'], 0, 'a is b'],
    ['row %# of %$', [], 2, 'row 2 of 3'],
    ['100%% %s', ['sure'], 0, '100% sure'],
    ['%i and %f', [3.7, 3.7], 0, '3 and 3.7'],
    ['%j', [{ a: 1 }], 0, '{"a":1}'],
    ['%p', [{ a: [1] }], 0, '{ a: [ 1 ] }'],
    ['%s %s', ['only one'], 0, 'only one %s'],
    ['$name is $age', { name: 'Ada', age: 36 }, 0, 'Ada is 36'],
    ['$user.name', { user: { name: 'Ada' } }, 0, 'Ada'],
    ['$missing', { name: 'Ada' }, 0, 'undefined'],
    ['$name stays', ['array rows keep $vars'], 0, '$name stays'],
    ['%s', [{ a: 1 }], 0, '{ a: 1 }'],
  ]
  for (const [template, row, index, expected] of cases) {
    test(`${template} → ${expected}`, () => {
      assert.equal(formatEachTitle(template, row, index), expected)
    })
  }
})

test('snapshotKey joins the name and the count', () => {
  assert.equal(snapshotKey('suite > adds', 2), 'suite > adds 2')
})

test('environmentConditions: own list, then DOM, then node', () => {
  assert.deepEqual(environmentConditions({ name: 'jsdom', conditions: ['worker'] }), ['worker'])
  assert.deepEqual(environmentConditions({ name: 'happy-dom' }), ['browser'])
  assert.deepEqual(environmentConditions({ name: 'node' }), ['node'])
  assert.deepEqual(environmentConditions({ name: 'edge-runtime' }), ['node'])
})
