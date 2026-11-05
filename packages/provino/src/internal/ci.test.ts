import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCi } from './ci.ts'

describe('isCi', () => {
  it('is true when CI is set to anything but empty, false or 0', () => {
    for (const value of ['true', '1', 'yes', 'TRUE', 'github']) {
      assert.equal(isCi({ CI: value }), true, value)
    }
  })

  it('is false when CI is unset, empty, false or 0', () => {
    assert.equal(isCi({}), false)
    for (const value of ['', 'false', '0']) {
      assert.equal(isCi({ CI: value }), false, JSON.stringify(value))
    }
  })

  it('ignores case and surrounding spaces, as the normalized-json reporter did', () => {
    for (const value of ['FALSE', 'False', ' false ', '\tfalse\n', ' 0 ', ' ', '  ']) {
      assert.equal(isCi({ CI: value }), false, JSON.stringify(value))
    }
    for (const value of [' true ', ' TRUE', ' 1 ', ' yes']) {
      assert.equal(isCi({ CI: value }), true, JSON.stringify(value))
    }
  })
})
