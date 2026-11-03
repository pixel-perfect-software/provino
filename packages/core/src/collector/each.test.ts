// `.each`/`.for` row normalization: which shapes spread into arguments, how a template table
// becomes rows, and what is rejected. Titles are the policy's `formatEachTitle`, not tested here.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { eachRows } from './each.ts'

/** `eachRows` called the way a tagged template calls it. */
const table = (strings: TemplateStringsArray, ...values: unknown[]) => eachRows(strings, values)

describe('eachRows with a list of rows', () => {
  test('an array row spreads into arguments and is passed to .for unspread', () => {
    const [row] = eachRows([[1, 2]], [])
    assert.deepEqual(row, { row: [1, 2], args: [1, 2], item: [1, 2] })
  })

  test('an object row is one argument', () => {
    const item = { a: 1 }
    const [row] = eachRows([item], [])
    assert.deepEqual(row?.args, [item])
    assert.equal(row?.args[0], item)
    assert.equal(row?.item, item)
  })

  test('a primitive row is one argument, titled as a one-item row', () => {
    const [row] = eachRows([7], [])
    assert.deepEqual(row, { row: [7], args: [7], item: 7 })
  })

  test('null and undefined rows are primitives too', () => {
    assert.deepEqual(
      eachRows([null, undefined], []).map((row) => row.args),
      [[null], [undefined]],
    )
  })

  test('no rows gives no tests', () => {
    assert.deepEqual(eachRows([], []), [])
  })
})

describe('eachRows with a template table', () => {
  test('each line is an object row keyed by the headings', () => {
    const rows = table`
      a    | b
      ${1} | ${2}
      ${3} | ${4}
    `
    assert.deepEqual(
      rows.map((row) => row.args),
      [[{ a: 1, b: 2 }], [{ a: 3, b: 4 }]],
    )
    assert.deepEqual(rows[0]?.item, { a: 1, b: 2 })
  })

  test('spaces around the headings are ignored', () => {
    const [row] = table`   first   |   second   ${1} | ${2}`
    assert.deepEqual(row?.item, { first: 1, second: 2 })
  })

  test('a table with one column works', () => {
    const rows = table`
      n
      ${1}
      ${2}
    `
    assert.deepEqual(
      rows.map((row) => row.item),
      [{ n: 1 }, { n: 2 }],
    )
  })

  test('a table with a heading and no values gives no rows', () => {
    assert.deepEqual(table`a | b`, [])
  })

  test('values that do not fill whole lines are a TypeError', () => {
    assert.throws(
      () => table`
        a    | b
        ${1} | ${2}
        ${3}
      `,
      TypeError,
    )
  })

  test('a table with no heading is a TypeError', () => {
    assert.throws(() => table``, TypeError)
  })
})

describe('eachRows with anything else', () => {
  for (const [what, value] of [
    ['a string', 'rows'],
    ['an object', { a: 1 }],
    ['a number', 3],
    ['undefined', undefined],
  ] as const) {
    test(`${what} is a TypeError`, () => {
      assert.throws(() => eachRows(value, []), TypeError)
    })
  }
})
