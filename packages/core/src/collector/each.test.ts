// `.each`/`.for` row normalization: which shapes spread into arguments, how a template table
// becomes rows, and what a strict or lenient read rejects (`collect.eachTableError`). Titles are the
// policy's `formatEachTitle`, not tested here.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { eachRows } from './each.ts'

/** `eachRows` called the way a tagged template calls it, read leniently. */
const table = (strings: TemplateStringsArray, ...values: unknown[]) =>
  eachRows(strings, values, false)

/** The same, read strictly. */
const strictTable = (strings: TemplateStringsArray, ...values: unknown[]) =>
  eachRows(strings, values, true)

describe('eachRows with a list of rows', () => {
  test('an array row spreads into arguments and is passed to .for unspread', () => {
    const [row] = eachRows([[1, 2]], [], false)
    assert.deepEqual(row, { row: [1, 2], args: [1, 2], item: [1, 2] })
  })

  test('in a table that mixes arrays and other rows, no row spreads', () => {
    const rows = eachRows([[1, 2], { a: 1 }, 3], [], false)
    assert.deepEqual(
      rows.map((row) => row.args),
      [[[1, 2]], [{ a: 1 }], [3]],
    )
    assert.deepEqual(rows[0]?.item, [1, 2])
  })

  test('an object row is one argument', () => {
    const item = { a: 1 }
    const [row] = eachRows([item], [], false)
    assert.deepEqual(row?.args, [item])
    assert.equal(row?.args[0], item)
    assert.equal(row?.item, item)
  })

  test('a primitive row is one argument, titled as a one-item row', () => {
    const [row] = eachRows([7], [], false)
    assert.deepEqual(row, { row: [7], args: [7], item: 7 })
  })

  test('null and undefined rows are primitives too', () => {
    assert.deepEqual(
      eachRows([null, undefined], [], false).map((row) => row.args),
      [[null], [undefined]],
    )
  })

  test('lenient: no rows gives no tests', () => {
    assert.deepEqual(eachRows([], [], false), [])
  })

  test('strict: no rows is a TypeError', () => {
    assert.throws(() => eachRows([], [], true), TypeError)
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

  test('lenient: a table with a heading and no values gives no rows', () => {
    assert.deepEqual(table`a | b`, [])
  })

  test('strict: a table with a heading and no values is a TypeError', () => {
    assert.throws(() => strictTable`a | b`, TypeError)
  })

  test('lenient: values that do not fill the last line drop that line', () => {
    const rows = table`
      a    | b
      ${1} | ${2}
      ${3}
    `
    assert.deepEqual(
      rows.map((row) => row.item),
      [{ a: 1, b: 2 }],
    )
  })

  test('strict: values that do not fill whole lines are a TypeError', () => {
    assert.throws(
      () => strictTable`
        a    | b
        ${1} | ${2}
        ${3}
      `,
      TypeError,
    )
  })

  test('a table with no heading is a TypeError, strict or not', () => {
    assert.throws(() => table``, TypeError)
    assert.throws(() => strictTable``, TypeError)
  })
})

describe('eachRows with anything else', () => {
  for (const [what, value] of [
    ['a string', 'rows'],
    ['an object', { a: 1 }],
    ['a number', 3],
    ['undefined', undefined],
  ] as const) {
    test(`${what} is a TypeError, strict or not`, () => {
      assert.throws(() => eachRows(value, [], false), TypeError)
      assert.throws(() => eachRows(value, [], true), TypeError)
    })
  }
})
