// `show` and `diffLines`: Node's `util.diff` is experimental, so its entry shape is pinned here.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { diff } from 'node:util'
import { diffLines, show } from './print.ts'

describe('print', () => {
  test('util.diff: [0|1|-1, line], a line only in the first argument is 1', () => {
    assert.deepEqual(diff(['a', 'X'], ['a', 'Y']), [
      [0, 'a'],
      [1, 'X'],
      [-1, 'Y'],
    ])
    assert.ok(diff(['a'], ['a']).every(([op]) => op === 0))
  })

  test('show prints on one line through inspect', () => {
    assert.equal(show({ a: [1, 'x'], b: undefined }), "{ a: [ 1, 'x' ], b: undefined }")
    assert.equal(show('s'), "'s'")
  })

  test('diffLines marks expected-only lines - and received-only lines +', () => {
    assert.equal(
      diffLines('one\ntwo\nthree', 'one\n2\nthree'),
      ['- Expected', '+ Received', '', '  one', '+ 2', '- two', '  three'].join('\n'),
    )
  })

  test('diffLines is undefined when the printed forms are equal', () => {
    assert.equal(diffLines({ a: 1 }, { a: 1 }), undefined)
  })

  test('objects are printed with sorted keys, so key order is no difference', () => {
    assert.equal(diffLines({ a: 1, b: 2 }, { b: 2, a: 1 }), undefined)
  })
})
