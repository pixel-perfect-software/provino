import { clamp } from '../src/used.ts'

describe('clamp', () => {
  test('keeps a value inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  test('raises a value below the range', () => {
    expect(clamp(-1, 0, 10)).toBe(0)
  })
})
