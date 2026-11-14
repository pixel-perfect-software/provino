import { greet } from '../src/greet.js'

test('greets grace', () => {
  expect(greet('grace')).toBe('hello grace')
})
