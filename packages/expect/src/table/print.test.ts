// `show` and `diffLines`: Node's `util.diff` is experimental, so its entry shape is pinned here.
import assert from 'node:assert/strict'
import { diff } from 'node:util'
import { describe, test } from 'provino'
import { diffLines, show } from './print.ts'

const numbered = (count: number, change?: number): string =>
  Array.from({ length: count }, (_, i) => (i === change ? 'changed' : `line ${i}`)).join('\n')

describe('print', () => {
  test('a large difference is not computed: the block says so and stays small', () => {
    const block = diffLines(numbered(20_000), numbered(20_000, 10_000))
    assert.ok(block !== undefined)
    assert.ok(block.split('\n').length < 10, block)
    assert.match(block, /too large to diff: 20000 lines/)
  })

  test('a small difference keeps a few lines of context and skips the common run', () => {
    const block = diffLines(numbered(200), numbered(200, 100))
    assert.ok(block !== undefined)
    const lines = block.split('\n')
    assert.ok(lines.length < 25, String(lines.length))
    assert.ok(lines.includes('+ changed'))
    assert.ok(lines.includes('- line 100'))
    assert.ok(lines.includes('  line 98'))
    assert.ok(!lines.includes('  line 50'))
    assert.ok(lines.some((line) => /^ {2}\.\.\. \d+ unchanged lines?$/.test(line)))
  })

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
