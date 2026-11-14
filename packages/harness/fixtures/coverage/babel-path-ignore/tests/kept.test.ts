import { skipped } from '../src/generated/skipped.ts'
import { kept } from '../src/kept.ts'

test('keeps a positive value', () => {
  expect(kept(2)).toBe(2)
})

test('doubles in a module coverage ignores', () => {
  expect(skipped(2)).toBe(4)
})
