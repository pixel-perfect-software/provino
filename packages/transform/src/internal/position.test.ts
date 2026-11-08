import assert from 'node:assert/strict'
import { test } from 'node:test'
import { positionCursor, positionOf } from './position.ts'

const CODE = 'ab\ncd\n\nef'

test('positionOf: 1-based, with a newline on the line it ends', () => {
  assert.deepEqual(positionOf(CODE, 0), { line: 1, column: 1 })
  assert.deepEqual(positionOf(CODE, 2), { line: 1, column: 3 })
  assert.deepEqual(positionOf(CODE, 3), { line: 2, column: 1 })
  assert.deepEqual(positionOf(CODE, 6), { line: 3, column: 1 })
  assert.deepEqual(positionOf(CODE, 8), { line: 4, column: 2 })
})

test('positionCursor: ascending offsets, repeats included, read as positionOf does', () => {
  const at = positionCursor(CODE)
  for (const offset of [0, 0, 1, 3, 3, 6, 7, 8, 9]) {
    assert.deepEqual(at(offset), positionOf(CODE, offset))
  }
})
