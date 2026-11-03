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

test('lines both texts start and end with are not compared, so a big file with one change diffs exactly', () => {
  const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`)
  const inserted = lines.toSpliced(2_500, 0, 'added')
  assert.equal(
    lineDiff(lines.join('\n'), inserted.join('\n')),
    ['  ...', '  line 2499', '+ added', '  line 2500', '  ...'].join('\n'),
  )
  const replaced = lines.toSpliced(10, 1, 'changed')
  assert.equal(
    lineDiff(lines.join('\n'), replaced.join('\n')),
    ['  ...', '  line 9', '- line 10', '+ changed', '  line 11', '  ...'].join('\n'),
  )
})

test('a change that reaches either end is still shown, with its context', () => {
  assert.equal(lineDiff('a\nb\nc', 'x\nb\nc'), ['- a', '+ x', '  b', '  ...'].join('\n'))
  assert.equal(lineDiff('a\nb\nc', 'a\nb\nx'), ['  ...', '  b', '- c', '+ x'].join('\n'))
  assert.equal(lineDiff('a', 'a\nb'), ['  a', '+ b'].join('\n'))
  assert.equal(lineDiff('', 'a'), ['- ', '+ a'].join('\n'))
})

test('a big stretch that differs falls back to a line-by-line comparison, between the shared ends', () => {
  const middle = (prefix: string) => Array.from({ length: 2_500 }, (_, i) => `${prefix}${i}`)
  const expected = ['head', ...middle('old'), 'tail'].join('\n')
  const actual = ['head', ...middle('new'), 'tail'].join('\n')
  const diff = lineDiff(expected, actual).split('\n')
  assert.equal(diff[0], '  head')
  assert.equal(diff.at(-1), '  tail')
  assert.equal(diff.filter((line) => line.startsWith('- ')).length, 2_500)
  assert.equal(diff.filter((line) => line.startsWith('+ ')).length, 2_500)
  assert.deepEqual(diff.slice(1, 3), ['- old0', '+ new0'])
})
