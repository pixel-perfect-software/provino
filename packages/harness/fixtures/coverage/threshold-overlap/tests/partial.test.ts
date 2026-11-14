import { used } from '../src/deep/partial.ts'

test('calls one of two functions', () => {
  expect(used()).toBe(1)
})
