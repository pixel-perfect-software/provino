import { total } from '../src/deep/total.ts'
import { grade } from '../src/grade.ts'

test('grades a high score', () => {
  expect(grade(95)).toBe('A')
})

test('adds values', () => {
  expect(total([1, 2, 3])).toBe(6)
})
