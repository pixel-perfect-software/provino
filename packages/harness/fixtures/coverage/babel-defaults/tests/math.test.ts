import { clamp, sign } from '../src/math.ts'

test('clamps below the range', () => {
  expect(clamp(-5, 0, 10)).toBe(0)
})

test('keeps a value inside the range', () => {
  expect(clamp(5, 0, 10)).toBe(5)
})

test('signs a negative number', () => {
  expect(sign(-3)).toBe(-1)
})
