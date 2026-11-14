import { add } from '../src/add.ts'
import { inside } from '../sub/inside.ts'

test('adds', () => {
  expect(add(1, 2)).toBe(3)
})

test('keeps a positive value', () => {
  expect(inside(2)).toBe(2)
})
