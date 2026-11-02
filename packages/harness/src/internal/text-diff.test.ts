import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineDiff } from './text-diff.ts'

test('equal texts have no diff', () => {
  assert.equal(lineDiff('a\nb\n', 'a\nb\n'), '')
})

test('a changed line shows as - and + with one line of context', () => {
  const expected = ['1', '2', '3', '4', '5', '6', '7'].join('\n')
  const actual = ['1', '2', '3', 'four', '5', '6', '7'].join('\n')
  assert.equal(
    lineDiff(expected, actual),
    ['  ...', '  3', '- 4', '+ four', '  5', '  ...'].join('\n'),
  )
})

test('an inserted and a removed line are each reported once', () => {
  assert.equal(lineDiff('a\nc', 'a\nb\nc'), ['  a', '+ b', '  c'].join('\n'))
  assert.equal(lineDiff('a\nb\nc', 'a\nc'), ['  a', '- b', '  c'].join('\n'))
})

test('very large inputs fall back to a line-by-line comparison', () => {
  const big = Array.from({ length: 2_500 }, (_, i) => String(i))
  const changed = big.toSpliced(1_000, 1, 'x')
  const diff = lineDiff(big.join('\n'), changed.join('\n'))
  assert.match(diff, /^ {2}\.\.\.\n {2}999\n- 1000\n\+ x\n {2}1001\n {2}\.\.\.$/)
})
