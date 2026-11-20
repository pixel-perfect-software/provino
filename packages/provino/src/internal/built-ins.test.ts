import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { NATIVE_API, NATIVE_TABLE_VARIABLE, nativeRuntime } from './built-ins.ts'
import { UsageError } from './usage-error.ts'

describe('nativeRuntime (PROVINO_NATIVE_MATCHER_TABLE, until B27e)', () => {
  test('no variable, or an empty one: no native runtime', () => {
    assert.equal(nativeRuntime({}), undefined)
    assert.equal(nativeRuntime({ [NATIVE_TABLE_VARIABLE]: '' }), undefined)
  })

  test('a file: URL or an absolute path, with an export, is the table ref', () => {
    assert.deepEqual(nativeRuntime({ [NATIVE_TABLE_VARIABLE]: 'file:///x/table.mjs#table' }), {
      ...NATIVE_API,
      matcherTable: { module: 'file:///x/table.mjs', export: 'table' },
    })
    assert.deepEqual(nativeRuntime({ [NATIVE_TABLE_VARIABLE]: '/x/table.mjs' })?.matcherTable, {
      module: '/x/table.mjs',
      export: 'default',
    })
  })

  for (const [what, value] of [
    ['a relative module', './table.mjs#table'],
    ['a bare specifier', 'some-table#table'],
    ['an empty export (a trailing #)', 'file:///x/table.mjs#'],
    ['a URL that is not file:', 'https://example.test/table.mjs#table'],
    ['a data: URL', 'data:text/javascript,export const table = 1#table'],
  ] as const) {
    test(`refuses ${what}, naming the variable`, () => {
      assert.throws(
        () => nativeRuntime({ [NATIVE_TABLE_VARIABLE]: value }),
        (error: unknown) =>
          error instanceof UsageError && error.message.includes(NATIVE_TABLE_VARIABLE),
      )
    })
  }
})
